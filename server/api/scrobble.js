const express = require('express');
const lastfm = require('../utils/lastfm');
const { Scrobble, sequelize, getValidLastFmUsers, cleanupOrphanedScrobbles } = require('../utils/db');
const router = express.Router();

router.get('/data', async (req, res) => {
    try {
        const friends = await getValidLastFmUsers();
        
        // Limpeza de scrobbles em background (não bloqueia a requisição)
        cleanupOrphanedScrobbles(friends);

        console.log(`[API] Solicitando dados para usuários do LastFM: ${friends.length > 0 ? friends.join(', ') : 'Nenhum'}`);

        const filterUser = req.query.user || 'group';
        
        // Se solicitou um usuário específico que não é válido, interrompe
        if (filterUser !== 'group' && !friends.includes(filterUser)) {
            return res.json({
                error: 'Usuário não encontrado ou não tem a conta LastFM associada.'
            });
        }

        const period = req.query.period || '7day';

        const usersToFetch = filterUser === 'group' ? friends : [filterUser];
        
        // Garante que a sincronização ocorra para os usuários solicitados
        await Promise.all(usersToFetch.map(user => {
             console.log(`[API] Disparando sincronização em background para: ${user}`);
             return lastfm.syncUserScrobbles(user).catch(e => console.error(`[Sync Error] ${user}:`, e));
        }));

        // Fetch DB Stats
        const dbStats = await Scrobble.findAll({
            attributes: [
                'user',
                [sequelize.fn('COUNT', sequelize.col('uts')), 'total']
            ],
            group: ['user'],
            raw: true
        });

        const statsMap = {};
        dbStats.forEach(s => statsMap[s.user] = s.total);

        const rawData = {};
        await Promise.all(usersToFetch.map(async (user) => {
            const [artists, tracks, tags] = await Promise.all([
                lastfm.getTopArtists(user, period, 10),
                lastfm.getTopTracks(user, period, 10),
                lastfm.getTopTags(user, period, 10)
            ]);
            rawData[user] = { artists, tracks, tags };
        }));

        const recentActivity = {};
        await Promise.all(friends.map(async friend => {
            recentActivity[friend] = await lastfm.getRecentTracks(friend, 1);
        }));

        const aggregated = { artists: {}, tracks: {}, tags: {} };
        for (const user in rawData) {
            if (rawData[user].artists) {
                rawData[user].artists.forEach(a => {
                    if (!aggregated.artists[a.name]) aggregated.artists[a.name] = 0;
                    aggregated.artists[a.name] += parseInt(a.playcount || 0);
                });
            }
            if (rawData[user].tracks) {
                rawData[user].tracks.forEach(t => {
                    const trackKey = `${t.artist.name} - ${t.name}`;
                    if (!aggregated.tracks[trackKey]) aggregated.tracks[trackKey] = 0;
                    aggregated.tracks[trackKey] += parseInt(t.playcount || 0);
                });
            }
            if (rawData[user].tags) {
                rawData[user].tags.forEach(g => {
                    if (!aggregated.tags[g.name]) aggregated.tags[g.name] = 0;
                    aggregated.tags[g.name] += parseInt(g.count || 0);
                });
            }
        }

        const sortAndSlice = (obj) => Object.entries(obj)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const timelineResults = await Promise.all(usersToFetch.map(u => {
            const days = period === '1month' ? 30 : 
                         period === '6month' ? 180 : 
                         period === '12month' ? 365 :
                         period === 'overall' ? 'overall' : 7;
            return lastfm.getTemporalData(u, days);
        }));

        if (timelineResults.length === 0 || !timelineResults[0]) {
            return res.json({
                dbStats: statsMap,
                aggregated: { artists: [], tracks: [], tags: [] },
                recentActivity: {},
                timeline: { labels: [], datasets: [] },
                genres: { labels: [], datasets: [] }
            });
        }

        const labels = timelineResults[0].labels;
        const totalTimelineValues = labels.map((_, i) => timelineResults.reduce((sum, res) => sum + (res.values[i] || 0), 0));

        // Aggregate genre data across all users per date label
        const aggregatedGenreData = {};
        const genreOverallTotals = {};

        labels.forEach(date => {
            aggregatedGenreData[date] = {};
            timelineResults.forEach(res => {
                const dayData = res.genreData[date] || {};
                Object.entries(dayData).forEach(([genre, count]) => {
                    aggregatedGenreData[date][genre] = (aggregatedGenreData[date][genre] || 0) + count;
                    genreOverallTotals[genre] = (genreOverallTotals[genre] || 0) + count;
                });
            });
        });

        // Limit to 9 main genres TOTAL across the entire chart + 'Outros'
        const top9OverallGenres = Object.entries(genreOverallTotals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 9)
            .map(([genre]) => genre);

        const wavesData = {};
        
        // Initialize waves for top 9 and a collector for "Outros"
        top9OverallGenres.forEach(genre => {
            wavesData[genre] = labels.map(() => 0);
        });
        wavesData['Outros'] = labels.map(() => 0);

        labels.forEach((date, dateIdx) => {
            const dayData = aggregatedGenreData[date];
            // Sort to find the top 7 for THIS day among all genres
            const sortedDay = Object.entries(dayData).sort((a, b) => b[1] - a[1]);
            const top7InDay = sortedDay.slice(0, 7).map(([g]) => g);

            // For each genre that has data on this day
            Object.entries(dayData).forEach(([genre, count]) => {
                if (top7InDay.includes(genre) && top9OverallGenres.includes(genre)) {
                    // It's a top 7 of the day AND a top 9 overall
                    wavesData[genre][dateIdx] = count;
                } else {
                    // Everything else goes to Outros to maintain the total area
                    wavesData['Outros'][dateIdx] += count;
                }
            });
        });

        res.json({
            topArtists: sortAndSlice(aggregated.artists),
            topTracks: sortAndSlice(aggregated.tracks),
            topTags: sortAndSlice(aggregated.tags),
            recentActivity,
            timelineData: { labels, values: totalTimelineValues, wavesData },
            dbStats: statsMap
        });
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
    res.send(200);
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
