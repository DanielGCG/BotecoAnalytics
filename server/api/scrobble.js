const express = require('express');
const lastfm = require('../utils/lastfm');
const { Scrobble, sequelize, getValidLastFmUsers, cleanupOrphanedScrobbles } = require('../utils/db');
const router = express.Router();

// Cache em memória para requisições de dashboard (acelera auto-refresh e navegações curtas)
const dashboardCache = new Map();
const DASHBOARD_CACHE_TTL = 20 * 1000; // 20 segundos

router.get('/data', async (req, res) => {
    try {
        const friends = await getValidLastFmUsers();
        
        // Background workers (disparam síncrono mas não bloqueiam a API)
        cleanupOrphanedScrobbles(friends);
        lastfm.syncMissingGenresCooldown();

        const queryUsers = req.query.user ? (Array.isArray(req.query.user) ? req.query.user : req.query.user.split(',')) : ['group'];
        const isGroup = queryUsers.length === 1 && queryUsers[0] === 'group';
        const period = req.query.period || '7day';

        // Check Cache ANTES de ir no banco
        const cacheKey = `dash_${queryUsers.sort().join('-')}_${period}`;
        const cached = dashboardCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < DASHBOARD_CACHE_TTL) {
            return res.json(cached.data);
        }

        console.log(`[API] Solicitando dados p/ processamento (Cache Miss): ${friends.length > 0 ? friends.join(', ') : 'Nenhum'}`);

        // Verifica se os usuários existem (se não formos um grupo)
        if (!isGroup) {
            for (const u of queryUsers) {
                if (!friends.includes(u)) {
                    return res.json({
                        error: `Usuário ${u} não encontrado ou não tem conta associada.`
                    });
                }
            }
        }

        // usesToFetch identifica quem vamos processar
        const usersToFetch = isGroup ? friends : queryUsers;
        
        // Garante que a sincronização ocorra em background (sem aguardar o await aqui)
        usersToFetch.forEach(user => {
             lastfm.syncUserScrobbles(user).catch(e => console.error(`[Sync Error] ${user}:`, e));
        });

        // Fetch DB Stats e Background Stats em paralelo
        const [dbStats, totalTracksResult, totalGenres] = await Promise.all([
            Scrobble.findAll({
                attributes: ['user', [sequelize.fn('COUNT', sequelize.col('uts')), 'total']],
                group: ['user'],
                raw: true
            }),
            sequelize.query(`SELECT COUNT(DISTINCT artist, track) as total FROM sb_scrobbles`),
            (async () => {
                try {
                    const { TrackGenre } = require('../utils/db');
                    return await TrackGenre.count();
                } catch (e) { return 0; }
            })()
        ]);

        const statsMap = {};
        dbStats.forEach(s => statsMap[s.user] = s.total);

        const totalUniqueTracks = totalTracksResult[0] && totalTracksResult[0][0] && totalTracksResult[0][0].total ? parseInt(totalTracksResult[0][0].total) : 0;
        
        const rawData = {};
        const recentActivity = {};
        
        // Fetch de dados de artistas/tracks/tags e atividade recente em paralelo
        await Promise.all([
            ...usersToFetch.map(async (user) => {
                const [artists, tracks, tags] = await Promise.all([
                    lastfm.getTopArtists(user, period, 20),
                    lastfm.getTopTracks(user, period, 20),
                    lastfm.getTopTags(user, period, 100)
                ]);
                rawData[user] = { artists, tracks, tags };
            }),
            ...friends.map(async friend => {
                recentActivity[friend] = await lastfm.getRecentTracks(friend, 1);
            })
        ]);

        const aggregated = { artists: {}, tracks: {}, tags: {} };
        for (const user in rawData) {
            const artists = Array.isArray(rawData[user].artists) ? rawData[user].artists : [];
            artists.forEach(a => {
                if (!aggregated.artists[a.name]) aggregated.artists[a.name] = 0;
                aggregated.artists[a.name] += parseInt(a.playcount || 0);
            });
            
            const tracks = Array.isArray(rawData[user].tracks) ? rawData[user].tracks : [];
            tracks.forEach(t => {
                const trackKey = `${t.artist.name} - ${t.name}`;
                if (!aggregated.tracks[trackKey]) aggregated.tracks[trackKey] = 0;
                aggregated.tracks[trackKey] += parseInt(t.playcount || 0);
            });

            const tags = Array.isArray(rawData[user].tags) ? rawData[user].tags : [];
            tags.forEach(g => {
                if (!aggregated.tags[g.name]) aggregated.tags[g.name] = 0;
                aggregated.tags[g.name] += parseInt(g.count || 0);
            });
        }

        const sortAndSlice = (obj, limit = 20) => Object.entries(obj)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);

        // Formata os dados brutos individuais para enviar ao frontend
        const individualStats = {};
        for (const user in rawData) {
            individualStats[user] = {
                artists: rawData[user].artists ? (Array.isArray(rawData[user].artists) ? rawData[user].artists.map(a => [a.name, parseInt(a.playcount || 0)]) : []) : [],
                tracks: rawData[user].tracks ? (Array.isArray(rawData[user].tracks) ? rawData[user].tracks.map(t => [`${t.artist.name} - ${t.name}`, parseInt(t.playcount || 0)]) : []) : [],
                tags: rawData[user].tags ? (Array.isArray(rawData[user].tags) ? rawData[user].tags.map(g => [g.name, parseInt(g.count || 0)]) : []) : []
            };
            
            // Sort and slice each one
            individualStats[user].artists = individualStats[user].artists.sort((a,b) => b[1]-a[1]).slice(0, 20);
            individualStats[user].tracks = individualStats[user].tracks.sort((a,b) => b[1]-a[1]).slice(0, 20);
            individualStats[user].tags = individualStats[user].tags.sort((a,b) => b[1]-a[1]).slice(0, 20);
        }

        const timelineResults = await Promise.all(usersToFetch.map(u => {
            const days = period === '7day' ? 7 : period === '1month' ? 30 : period === '3month' ? 90 : period === '6month' ? 180 : period === '12month' ? 365 : period === 'overall' ? 'overall' : 7;
            return lastfm.getTemporalData(u, days);
        }));

        if (timelineResults.length === 0 || !timelineResults[0]) {
            return res.json({ labels: [], values: [], datasets: {} });
        }

        const labels = timelineResults[0].labels;
        const totalTimelineValues = labels.map((_, i) => timelineResults.reduce((sum, res) => sum + (res.values[i] || 0), 0));
        const aggregatedGenreData = {};
        const aggregatedArtistData = {};
        const artistOverallTotals = {};
        const userLinesData = {};

        usersToFetch.forEach(u => userLinesData[u] = new Array(labels.length).fill(0));

        labels.forEach((date, i) => {
            if (!aggregatedGenreData[date]) aggregatedGenreData[date] = {};
            if (!aggregatedArtistData[date]) aggregatedArtistData[date] = {};
            timelineResults.forEach((res, userIdx) => {
                const user = usersToFetch[userIdx];
                if (userLinesData[user]) {
                    userLinesData[user][i] = res.values[i] || 0;
                }
                const dayGenreData = res.genreTimeline ? res.genreTimeline[date] : (res.genreData ? res.genreData[date] : {});
                if (dayGenreData) {
                    Object.entries(dayGenreData).forEach(([genre, count]) => {
                        aggregatedGenreData[date][genre] = (aggregatedGenreData[date][genre] || 0) + count;
                    });
                }
                const dayArtistData = res.artistData ? res.artistData[date] : {};
                if (dayArtistData) {
                    Object.entries(dayArtistData).forEach(([artist, count]) => {
                        aggregatedArtistData[date][artist] = (aggregatedArtistData[date][artist] || 0) + count;
                        artistOverallTotals[artist] = (artistOverallTotals[artist] || 0) + count;
                    });
                }
            });
        });
 // Define exact list of genres for the timeline (including the special OST and MUSICAL)
        const timelineGenres = [
            'POP', 'POP ASIÁTICO', 'ROCK', 'METAL', 'PUNK', 'MPB', 'SAMBA / PAGODE', 
            'SERTANEJO', 'FORRÓ', 'FUNK', 'RAP / HIP-HOP', 'TRAP / PHONK', 
            'R&B / SOUL', 'LATIN', 'ELETRÔNICA', 'INDIE / ALT', 'JAZZ / BLUES', 
            'COUNTRY / FOLK', 'CLÁSSICA / INST', 'OST', 'MUSICAL', 'OUTROS'
        ];

        const wavesData = {};
        timelineGenres.forEach(genre => wavesData[genre] = labels.map(() => 0));

        // For the Bar Chart (Gêneros Estilos), we show only the top 20 real categories
        const finalAggregatedTags = Object.entries(aggregated.tags)
            .filter(([name]) => name && name.toUpperCase() !== 'OUTROS' && name !== 'null' && name !== 'NULL' && name !== 'undefined')
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);

        // O Top 10 artistas diários pode gerar muito mais que 10 artistas únicos na timeline
        const topArtistsSet = new Set();
        labels.forEach(date => {
            const dayArtistData = aggregatedArtistData[date] || {};
            const sortedDay = Object.entries(dayArtistData).sort((a, b) => b[1] - a[1]);
            const top20ThisDay = sortedDay.slice(0, 20).map(([a]) => a);
            top20ThisDay.forEach(a => topArtistsSet.add(a));
        });
        
        // Ordena a lista aglomerada pelos totais globais e limita (ex: máx 20 conforme solicitado)
        const finalTopArtists = Array.from(topArtistsSet)
            .sort((a, b) => (artistOverallTotals[b] || 0) - (artistOverallTotals[a] || 0))
            .slice(0, 20);

        const artistWavesData = {};
        finalTopArtists.forEach(artist => artistWavesData[artist] = labels.map(() => 0));

        labels.forEach((date, dateIdx) => {
            const dayGenreData = aggregatedGenreData[date] || {};
            
            Object.entries(dayGenreData).forEach(([genre, count]) => {
                if (timelineGenres.includes(genre)) {
                    wavesData[genre][dateIdx] = count;
                } else {
                    // Fallback para a timeline apenas
                    wavesData['OUTROS'][dateIdx] += count;
                }
            });

            const dayArtistData = aggregatedArtistData[date] || {};
            
            Object.entries(dayArtistData).forEach(([artist, count]) => {
                // Se o artista figura na elite da timeline de qualquer dia, ganha linha dedicada
                if (finalTopArtists.includes(artist)) {
                    artistWavesData[artist][dateIdx] = count;
                }
            });
        });

        // Pre-format datasets for Chart.js to reduce frontend CPU usage
        const genreDatasets = Object.entries(wavesData).map(([genre, data]) => ({
            label: genre,
            data,
            fill: 'origin',
            tension: 0.4,
            pointRadius: 0
        }));

        const artistDatasets = Object.entries(artistWavesData).map(([artist, data]) => ({
            label: artist,
            data,
            fill: false,
            tension: 0.4,
            pointRadius: 3
        }));

        const userDatasets = Object.entries(userLinesData).map(([user, data]) => ({
            label: user,
            data,
            fill: false,
            tension: 0.4,
            pointRadius: 3
        }));

        const fullResponse = {
            topArtists: sortAndSlice(aggregated.artists),
            topTracks: sortAndSlice(aggregated.tracks),
            topTags: finalAggregatedTags, // Já está sorteado e fatiado
            individualStats, // Dados para a ferramenta de comparação
            recentActivity,
            timelineData: { 
                labels, 
                values: totalTimelineValues, 
                datasets: {
                    genre: genreDatasets,
                    artist: artistDatasets,
                    user: userDatasets
                }
            },
            dbStats: statsMap,
            processingStats: {
                totalUniqueTracks,
                totalGenres
            }
        };

        // Salvar no Cache de Dashboard!
        dashboardCache.set(cacheKey, { timestamp: Date.now(), data: fullResponse });

        res.json(fullResponse);
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});

const lastTrackCache = new Map();
const weeklyTopTrackCache = new Map();
const TTL_LAST_TRACK_MS = 15 * 1000; // 15 segundos para atualizar rápido o "now playing"
const TTL_WEEKLY_TRACK_MS = 60 * 60 * 1000; // 1 hora para o top semanal

// Função auxiliar para ignorar a imagem padrão de "estrela" do Last.fm e pegar a real
async function getRealTrackImage(username, artist, trackName) {
    try {
        const response = await lastfm._request({
            method: 'track.getInfo',
            artist: artist,
            track: trackName,
            username: username,
            api_key: process.env.LASTFM_API_KEY,
            format: 'json'
        });
        const trackInfo = response?.data?.track;
        if (trackInfo && trackInfo.album && trackInfo.album.image) {
            const bestImage = trackInfo.album.image.find(img => img.size === 'extralarge' || img.size === 'large');
            if (bestImage && bestImage['#text'] && !bestImage['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) {
                return bestImage['#text'];
            }
        }
    } catch (e) {
        console.error('Error fetching real track image:', e.message);
    }
    return null;
}

router.options('/widget/:user', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.sendStatus(200);
});

router.get('/widget/:user', async (req, res) => {
    // Habilita o CORS para que outro projeto possa consumir a API sem bloqueios
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");

    const token = req.query.token || req.headers.authorization;
    const expectedToken = process.env.WIDGET_TOKEN || 'sua_senha_secreta_aqui';

    if (!token || (token !== expectedToken && token !== `Bearer ${expectedToken}`)) {
        return res.status(401).json({ error: 'Acesso negado: Token ausente ou inválido.' });
    }

    const username = req.params.user;
    
    // Atualização Inteligente e Separada (Now Playing Rápido vs Top Semanal que Demora)
    const now = Date.now();
    let lastTrackData = lastTrackCache.get(username);
    let weeklyTopData = weeklyTopTrackCache.get(username);

    try {
        if (!lastTrackData || now - lastTrackData.timestamp > TTL_LAST_TRACK_MS) {
            const recentTracks = await lastfm.getRecentTracks(username, 1);
            let lastTrack = null;
            if (recentTracks && recentTracks.length > 0) {
                const track = recentTracks[0];
                const bestImage = track.image ? track.image.find(img => img.size === 'extralarge' || img.size === 'large') : null;
                let imageUrl = bestImage ? bestImage['#text'] : null;

                // Remover a capa de estrela padrão do LastFM em fallback
                if (imageUrl && imageUrl.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
                    imageUrl = null; 
                }

                lastTrack = {
                    name: track.name,
                    artist: track.artist['#text'] || track.artist.name,
                    album: track.album ? track.album['#text'] : '',
                    image: imageUrl,
                    isNowPlaying: track['@attr'] && track['@attr'].nowplaying === 'true'
                };
            }
            lastTrackData = { timestamp: now, data: lastTrack };
            lastTrackCache.set(username, lastTrackData);
        }

        if (!weeklyTopData || now - weeklyTopData.timestamp > TTL_WEEKLY_TRACK_MS) {
            const topTracks = await lastfm.getTopTracks(username, '7day', 1);
            let weeklyTopTrack = null;
            if (topTracks && topTracks.length > 0) {
                const track = topTracks[0];
                let imageUrl = null;
                
                // O getTopTracks frequentemente não envia imagem real. Vamos obter detalhada:
                const realImage = await getRealTrackImage(username, track.artist.name, track.name);
                
                if (realImage) {
                    imageUrl = realImage;
                } else {
                    const fallbackImage = track.image ? track.image.find(img => img.size === 'extralarge' || img.size === 'large') : null;
                    if (fallbackImage && fallbackImage['#text'] && !fallbackImage['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) {
                        imageUrl = fallbackImage['#text'];
                    }
                }

                weeklyTopTrack = {
                    name: track.name,
                    artist: track.artist.name,
                    playcount: track.playcount,
                    image: imageUrl
                };
            }
            weeklyTopData = { timestamp: now, data: weeklyTopTrack };
            weeklyTopTrackCache.set(username, weeklyTopData);
        }

        return res.json({
            user: username,
            lastTrack: lastTrackData.data,
            weeklyTopTrack: weeklyTopData.data
        });

    } catch (error) {
        console.error('Widget API Error:', error);
        return res.status(500).json({ error: 'Erro ao buscar os dados do widget.' });
    }
});

module.exports = router;
