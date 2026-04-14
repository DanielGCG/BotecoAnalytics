const axios = require('axios');
const { Scrobble, TrackGenre, sequelize } = require('./db');
const { Op } = require('sequelize');
require('dotenv').config();

const API_KEY = process.env.LASTFM_API_KEY;
const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

const lastfm = {
  /**
   * Internal helper to handle Axios requests with retry logic
   */
  _isSyncingGenres: false,

  async syncMissingGenresCooldown() {
    if (this._isSyncingGenres) return;
    this._isSyncingGenres = true;

    try {
        const query = `
            SELECT DISTINCT s.artist, s.track 
            FROM sb_scrobbles s
            LEFT JOIN sb_trackgenres g ON g.artist COLLATE utf8mb4_unicode_ci = s.artist COLLATE utf8mb4_unicode_ci 
                                      AND g.track COLLATE utf8mb4_unicode_ci = s.track COLLATE utf8mb4_unicode_ci
            WHERE g.id IS NULL
            LIMIT 150
        `;
        // Utilizando o sequelize para rodar uma query crua eficiente
        const [missing] = await sequelize.query(query);

        if (missing.length > 0) {
            console.log(`[Genre DB Sync] Identificadas faixas pendentes. Buscando ${missing.length} novos gêneros com concorrência...`);
            
            // Acelerar consulta agrupando promessas (lotes paralelos de 5 com pausas leves)
            const chunkSize = 5;
            for (let i = 0; i < missing.length; i += chunkSize) {
                const chunk = missing.slice(i, i + chunkSize);
                await Promise.all(chunk.map(row => this.getTrackPrimaryGenre(row.artist, row.track)));
                await new Promise(r => setTimeout(r, 400)); // Dispara até 5 requests a cada ~400ms (respeita rate limit de forma mt + rápida)
            }
            
            console.log(`[Genre DB Sync] Lote de ${missing.length} faixas concluído.`);
            
            // Chama o próximo lote em apenas 1 segundo (antes eram 5)
            setTimeout(() => {
                this._isSyncingGenres = false;
                this.syncMissingGenresCooldown();
            }, 1000);
        } else {
            console.log(`[Genre DB Sync] 100% dos Scrobbles já possuem Cache de Gênero.`);
            this._isSyncingGenres = false;
        }
    } catch (e) {
        console.error(`[Genre DB Sync] Erro no worker:`, e.message);
        this._isSyncingGenres = false;
    }
  },

  async _request(params, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios.get(BASE_URL, { params, timeout: 10000 });
        } catch (error) {
            const isRateLimit = error.response && error.response.status === 429;
            const isNetworkError = !error.response;
            
            if (i < retries - 1 && (isRateLimit || isNetworkError || error.response.status >= 500)) {
                const delay = (i + 1) * 2000;
                console.warn(`[Last.fm] Request failed (${error.message}). Retrying in ${delay/1000}s... (Attempt ${i+1}/${retries})`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw error;
        }
    }
  },

  /**
   * Sync and fetch scrobbles for a user into MariaDB
   */
  async syncUserScrobbles(user) {
    // Get the latest UTS from the database
    const lastScrobble = await Scrobble.findOne({
      where: { user },
      order: [['uts', 'DESC']]
    });
    
    // Check for the OLDEST scrobble to know if we need to fetch historical data
    const oldestScrobble = await Scrobble.findOne({
      where: { user },
      order: [['uts', 'ASC']]
    });

    const lastSyncUts = lastScrobble ? lastScrobble.uts : 0;
    const oldestSyncUts = oldestScrobble ? oldestScrobble.uts : 0;

    console.log(`[Sync] ${user}: Newest ${lastSyncUts}, Oldest ${oldestSyncUts}. Initializing sync...`);

    try {
        let page = 1;
        let totalPages = 1;
        let totalNew = 0;

        // 1. PHASE ONE: Fetch NEW tracks (from newest in DB to 'now')
        if (lastSyncUts > 0) {
            console.log(`[Sync] ${user}: Catching up with newest tracks...`);
            do {
                const response = await this._request({
                    method: 'user.getrecenttracks',
                    user,
                    api_key: API_KEY,
                    format: 'json',
                    limit: 200,
                    page: page,
                    from: parseInt(lastSyncUts) + 1,
                    extended: 1
                });

                const data = response.data.recenttracks;
                if (!data || !data.track) break;

                const fetched = Array.isArray(data.track) ? data.track : [data.track];
                totalPages = parseInt(data['@attr'].totalPages);

                const newRecords = fetched
                    .filter(t => t.date && t.date.uts)
                    .map(t => ({
                        uts: parseInt(t.date.uts),
                        user,
                        artist: t.artist.name || t.artist['#text'],
                        track: t.name,
                        album: t.album ? t.album['#text'] : null,
                        date_str: new Date(parseInt(t.date.uts) * 1000).toISOString().split('T')[0]
                    }));

                if (newRecords.length > 0) {
                    await Scrobble.bulkCreate(newRecords, { ignoreDuplicates: true });
                    totalNew += newRecords.length;
                }

                if (page >= totalPages) break; 
                page++;
                await new Promise(r => setTimeout(r, 200));
            } while (page <= totalPages);
        }

        // 2. PHASE TWO: Fetch OLD tracks (from oldest in DB back to the beginning)
        // We use the 'to' parameter to fetch tracks OLDER than our oldest record
        let oldestPage = 1;
        let totalOldestPages = 1;
        let totalHistorical = 0;

        console.log(`[Sync] ${user}: Fetching historical data...`);
        do {
            const params = {
                method: 'user.getrecenttracks',
                user,
                api_key: API_KEY,
                format: 'json',
                limit: 200,
                page: oldestPage,
                extended: 1
            };

            // If we have data, fetch everything BEFORE our oldest UTS
            if (oldestSyncUts > 0) {
                params.to = parseInt(oldestSyncUts) - 1;
            }

            const response = await this._request(params);
            const data = response.data.recenttracks;
            
            if (!data || !data.track || (Array.isArray(data.track) && data.track.length === 0)) {
                break;
            }

            const fetched = Array.isArray(data.track) ? data.track : [data.track];
            totalOldestPages = parseInt(data['@attr'].totalPages);

            const historicalRecords = fetched
                .filter(t => t.date && t.date.uts)
                .map(t => ({
                    uts: parseInt(t.date.uts),
                    user,
                    artist: t.artist.name || t.artist['#text'],
                    track: t.name,
                    album: t.album ? t.album['#text'] : null,
                    date_str: new Date(parseInt(t.date.uts) * 1000).toISOString().split('T')[0]
                }));

            if (historicalRecords.length > 0) {
                await Scrobble.bulkCreate(historicalRecords, { ignoreDuplicates: true });
                totalHistorical += historicalRecords.length;
            }

            console.log(`[Sync] ${user}: Historical Page ${oldestPage} of ${totalOldestPages} (${totalHistorical} old tracks found)`);

            if (oldestPage >= totalOldestPages) break;
            oldestPage++;
            await new Promise(r => setTimeout(r, 200));
        } while (oldestPage <= totalOldestPages);

        console.log(`[Sync] ${user} complete. New: ${totalNew}, Historical: ${totalHistorical}`);
    } catch (error) {
        console.error(`[Sync] Error for ${user}:`, error.message);
    }
  },

  /**
   * Fetch top artists for a specific user.
   */
  async getTopArtists(user, period = '7day', limit = 10) {
    try {
      const response = await this._request({
          method: 'user.gettopartists',
          user,
          api_key: API_KEY,
          format: 'json',
          period,
          limit
      });
      return response.data.topartists ? response.data.topartists.artist : [];
    } catch (error) {
      console.error(`Error fetching top artists for ${user}:`, error.message);
      return [];
    }
  },

  /**
   * Fetch top tracks for a specific user.
   */
  async getTopTracks(user, period = '7day', limit = 10) {
    try {
      const response = await this._request({
          method: 'user.gettoptracks',
          user,
          api_key: API_KEY,
          format: 'json',
          period,
          limit
      });
      return response.data.toptracks ? response.data.toptracks.track : [];
    } catch (error) {
      console.error(`Error fetching top tracks for ${user}:`, error.message);
      return [];
    }
  },

  /**
   * Fetch top tags (genres) for a specific user based on their top tracks in a period.
   */
  async getTopTags(user, period = '7day', limit = 10) {
    try {
      let whereClause = `user = :user`;
      let replacements = { user };

      if (period !== 'overall') {
          const daysMap = { '7day': 7, '1month': 30, '3month': 90, '6month': 180, '12month': 365 };
          const days = daysMap[period] || 7;
          const now = Math.floor(Date.now() / 1000);
          whereClause += ` AND uts >= :fromUts`;
          replacements.fromUts = now - (days * 24 * 60 * 60);
      }

      const query = `
          SELECT 
              COALESCE(UPPER(g.genre), 'OUTROS') AS genre,
              COUNT(*) AS playcount
          FROM sb_scrobbles s
          LEFT JOIN sb_trackgenres g 
              ON s.artist COLLATE utf8mb4_unicode_ci = g.artist COLLATE utf8mb4_unicode_ci
              AND s.track COLLATE utf8mb4_unicode_ci = g.track COLLATE utf8mb4_unicode_ci
          WHERE s.${whereClause}
          GROUP BY genre
          ORDER BY playcount DESC
          LIMIT :limit
      `;
      replacements.limit = limit;

      const [results] = await sequelize.query(query, { replacements });

      return results.map(r => ({ name: r.genre, count: parseInt(r.playcount) }));
    } catch (error) {
      console.error(`Error fetching top tags for ${user}:`, error.message);
      return [];
    }
  },

  /**
   * Fetch recent tracks for a user with extended info (for better genre mapping later)
   */
  async getRecentTracks(user, limit = 50) {
    try {
      const response = await this._request({
          method: 'user.getrecenttracks',
          user,
          api_key: API_KEY,
          format: 'json',
          limit,
          extended: 1
      });
      return response.data.recenttracks ? response.data.recenttracks.track : [];
    } catch (error) {
      console.error(`Error fetching recent tracks for ${user}:`, error.message);
      return [];
    }
  },

  /**
   * Get real tags for a track from Last.fm
   */
  async getTrackTags(artist, track) {
    try {
      const response = await this._request({
          method: 'track.gettoptags',
          artist,
          track,
          api_key: API_KEY,
          format: 'json'
      });
      
      if (response.data && response.data.toptags && response.data.toptags.tag) {
          const tags = response.data.toptags.tag;
          return Array.isArray(tags) ? tags.slice(0, 10) : [tags];
      }
      return [];
    } catch (error) {
      return [];
    }
  },

  _mapTagsToGenre(tags) {
    const genreWhitelist = {
        // 1. POP
        'pop': 'POP', 'dance-pop': 'POP', 'synthpop': 'POP', 'electropop': 'POP', 'art pop': 'POP', 'hyperpop': 'POP', 'indie pop': 'POP', 'bedroom pop': 'POP', 'pop rock': 'POP', 'experimental pop': 'POP', 'dream pop': 'POP',
        // 2. K-POP / J-POP (ASIA)
        'k-pop': 'POP ASIÁTICO', 'kpop': 'POP ASIÁTICO', 'korean': 'POP ASIÁTICO', 'j-pop': 'POP ASIÁTICO', 'jpop': 'POP ASIÁTICO', 'japanese': 'POP ASIÁTICO', 'j-rock': 'POP ASIÁTICO', 'v-pop': 'POP ASIÁTICO',
        // 3. ROCK
        'rock': 'ROCK', 'alternative rock': 'ROCK', 'alt-rock': 'ROCK', 'indie rock': 'ROCK', 'classic rock': 'ROCK', 'hard rock': 'ROCK', 'grunge': 'ROCK', 'psychedelic rock': 'ROCK', 'soft rock': 'ROCK', 'glam rock': 'ROCK',
        // 4. METAL
        'metal': 'METAL', 'heavy metal': 'METAL', 'metalcore': 'METAL', 'death metal': 'METAL', 'black metal': 'METAL', 'thrash metal': 'METAL', 'nu metal': 'METAL', 'doom metal': 'METAL', 'power metal': 'METAL',
        // 5. PUNK
        'punk': 'PUNK', 'post-punk': 'PUNK', 'pop punk': 'PUNK', 'emo': 'PUNK', 'hardcore': 'PUNK', 'garage rock': 'PUNK',
        // 6. MPB
        'mpb': 'MPB', 'brazilian': 'MPB', 'nova mpb': 'MPB', 'tropicalia': 'MPB', 'bossa nova': 'MPB', 'manguebeat': 'MPB',
        // 7. SAMBA / PAGODE
        'samba': 'SAMBA / PAGODE', 'pagode': 'SAMBA / PAGODE',
        // 8. SERTANEJO
        'sertanejo': 'SERTANEJO', 'agronejo': 'SERTANEJO', 'sertanejo universitario': 'SERTANEJO',
        // 9. FORRÓ
        'forro': 'FORRÓ', 'forró': 'FORRÓ', 'piseiro': 'FORRÓ', 'baiao': 'FORRÓ', 'xote': 'FORRÓ',
        // 10. FUNK
        'funk carioca': 'FUNK', 'funk': 'FUNK', 'brega funk': 'FUNK', 'funk mtg': 'FUNK', 'funk paulista': 'FUNK',
        // 11. RAP / HIP-HOP
        'hip hop': 'RAP / HIP-HOP', 'rap': 'RAP / HIP-HOP', 'underground hip-hop': 'RAP / HIP-HOP', 'gangsta rap': 'RAP / HIP-HOP', 'boom bap': 'RAP / HIP-HOP',
        // 12. TRAP / PHONK
        'trap': 'TRAP / PHONK', 'phonk': 'TRAP / PHONK', 'drift phonk': 'TRAP / PHONK', 'brasilian trap': 'TRAP / PHONK',
        // 13. R&B / SOUL
        'r&b': 'R&B / SOUL', 'rnb': 'R&B / SOUL', 'soul': 'R&B / SOUL', 'neo-soul': 'R&B / SOUL', 'funk soul': 'R&B / SOUL',
        // 14. LATIN
        'reggaeton': 'LATIN', 'latin': 'LATIN', 'bachata': 'LATIN', 'urbano latino': 'LATIN', 'cumbia': 'LATIN', 'latin pop': 'LATIN', 'salsa': 'LATIN', 'merengue': 'LATIN',
        // 15. ELETRÔNICA
        'electronic': 'ELETRÔNICA', 'house': 'ELETRÔNICA', 'techno': 'ELETRÔNICA', 'dance': 'ELETRÔNICA', 'edm': 'ELETRÔNICA', 'dubstep': 'ELETRÔNICA', 'drum and bass': 'ELETRÔNICA', 'dnb': 'ELETRÔNICA', 'trance': 'ELETRÔNICA', 'synthwave': 'ELETRÔNICA', 'lo-fi': 'ELETRÔNICA', 'lofi': 'ELETRÔNICA', 'chillhop': 'ELETRÔNICA', 'ambient': 'ELETRÔNICA', 'trip-hop': 'ELETRÔNICA',
        // 16. INDIE / ALTERNATIVE
        'indie': 'INDIE / ALT', 'alternative': 'INDIE / ALT', 'indie folk': 'INDIE / ALT', 'shoegaze': 'INDIE / ALT', 'new wave': 'INDIE / ALT',
        // 17. JAZZ / BLUES
        'jazz': 'JAZZ / BLUES', 'blues': 'JAZZ / BLUES', 'fusion': 'JAZZ / BLUES', 'swing': 'JAZZ / BLUES',
        // 18. COUNTRY / FOLK
        'country': 'COUNTRY / FOLK', 'folk': 'COUNTRY / FOLK', 'bluegrass': 'COUNTRY / FOLK', 'americana': 'COUNTRY / FOLK',
        // 19. CLÁSSICA / INSTRUMENTAL
        'classical': 'CLÁSSICA / INST', 'classic': 'CLÁSSICA / INST', 'piano': 'CLÁSSICA / INST', 'instrumental': 'CLÁSSICA / INST', 'orchestra': 'CLÁSSICA / INST', 'opera': 'CLÁSSICA / INST',
        // 20. SOUNDTRACKS / MUSICAL
        'soundtrack': 'OST', 'ost': 'OST', 'score': 'OST', 'video game music': 'OST', 'vgm': 'OST', 'musical': 'MUSICAL', 'broadway': 'MUSICAL', 'show tunes': 'MUSICAL', 'west end': 'MUSICAL',
        // REALOCAÇÃO (Estatísticos)
        'reggae': 'LATIN', 'disco': 'POP', 'afrobeats': 'LATIN', 'afrobeat': 'LATIN', 'amapiano': 'ELETRÔNICA', 'ska': 'PUNK', 'dancehall': 'LATIN'
    };

    let genre = null;

    if (tags && tags.length > 0) {
        // Primeira rodada: busca exata
        for (const tag of tags) {
            const tagName = (tag.name || tag['#text'] || '').toLowerCase();
            if (!tagName) continue;

            if (genreWhitelist[tagName]) {
                genre = genreWhitelist[tagName];
                break;
            }
        }
        
        // Segunda rodada: busca por aproximação (includes)
        if (!genre) {
            for (const tag of tags) {
                const tagName = (tag.name || tag['#text'] || '').toLowerCase();
                if (!tagName) continue;

                for (const [key, value] of Object.entries(genreWhitelist)) {
                    if (tagName.includes(key) || tagName.includes(key.replace('-', ' '))) {
                        genre = value;
                        break;
                    }
                }
                if (genre) break;
            }
        }
    }
    
    // Se ainda for nulo, pegamos o gênero mais provável baseado em palavras-chave da primeira tag
    if (!genre && tags && tags.length > 0) {
        const firstTag = (tags[0].name || tags[0]['#text'] || '').toLowerCase();
        if (firstTag.includes('pop')) return 'POP';
        if (firstTag.includes('rock')) return 'ROCK';
        if (firstTag.includes('metal')) return 'METAL';
        if (firstTag.includes('rap') || firstTag.includes('hip hop')) return 'RAP / HIP-HOP';
        if (firstTag.includes('electronic') || firstTag.includes('dance')) return 'ELETRÔNICA';
        if (firstTag.includes('indie')) return 'INDIE / ALT';
        if (firstTag.includes('brazilian') || firstTag.includes('brasil')) return 'MPB';
    }

    // Fallback final: Se não houver nenhuma pista, agrupamos em "OUTROS"
    // Isso será usado apenas para o histórico temporal conforme solicitado
    return genre || 'OUTROS';
  },

  /**
   * Get primary genre for a track, using local DB as first-level cache
   */
  async getTrackPrimaryGenre(artistName, trackName) {
    const trackId = `${artistName}:::${trackName}`;
    
    // 1. Check Local DB
    const localEntry = await TrackGenre.findByPk(trackId);
    if (localEntry) return localEntry.genre;

    // 2. Fetch from Last.fm if not found locally
    const tags = await this.getTrackTags(artistName, trackName);
    let genre = this._mapTagsToGenre(tags);

    // 3. Save to local DB for next time
    try {
        await TrackGenre.upsert({ id: trackId, artist: artistName, track: trackName, genre });
    } catch (e) {}

    return genre;
  },

  /**
   * Process scrobbles from MariaDB to generate temporal data (scrobbles per day)
   */
  async getTemporalData(user, days = 7) {
    // 1. Trigger background sync
    this.syncUserScrobbles(user).catch(e => console.error("Sync error", e));
    
    // 2. Query MariaDB for the requested time range
    let whereClause = { user };
    if (days !== 'overall') {
        const now = Math.floor(Date.now() / 1000);
        const fromUts = now - (days * 24 * 60 * 60);
        whereClause.uts = { [Op.gte]: fromUts };
    }

    const tracks = await Scrobble.findAll({ where: whereClause, order: [['uts', 'ASC']] });

    const timeline = {};
    const genreTimeline = {};
    const artistTimeline = {};
    const groupKeyFn = (dateStr) => {
        if (!dateStr) return 'Unknown';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return 'Invalid Date';
        
        if (days === 'overall') {
            const semester = date.getUTCMonth() < 6 ? 'S1' : 'S2';
            return `${date.getUTCFullYear()} ${semester}`;
        }
        if (days >= 360) return dateStr.substring(0, 7); // YYYY-MM
        if (days >= 180) return `${dateStr.substring(0, 7)}-${date.getUTCDate() > 15 ? 'H2' : 'H1'}`;
        if (days >= 30) {
            const day = date.getUTCDate();
            const d = new Date(date);
            d.setUTCDate(day % 2 === 0 ? day : day - 1);
            return d.toISOString().split('T')[0];
        }
        return dateStr;
    };

    // To get all genres, we need to check the DB for all tracks
    const uniqueTracksInPeriod = [...new Set(tracks.map(t => `${t.artist}:::${t.track}`))];
    
    // Fetch all genres from DB at once if possible
    const localGenres = await TrackGenre.findAll({
        where: { id: { [Op.in]: uniqueTracksInPeriod } }
    });
    
    const trackGenres = {};
    localGenres.forEach(tg => {
        trackGenres[tg.id] = tg.genre;
    });

    // For any track not in DB, we fetch it (this will also save to DB)
    // Limits the fetching massively so we don't spam 1000 requests per user
    const missingTracks = uniqueTracksInPeriod.filter(id => !trackGenres[id]);
    const tracksToFetch = missingTracks.slice(0, 50); // Fetch up to 50 missing per request

    await Promise.all(tracksToFetch.map(async id => {
        const [artist, track] = id.split(':::');
        trackGenres[id] = await this.getTrackPrimaryGenre(artist, track);
    }));

    tracks.forEach(track => {
      const key = groupKeyFn(track.date_str);
      const trackId = `${track.artist}:::${track.track}`;
      const genre = trackGenres[trackId] || 'OUTROS';
      const artist = track.artist || 'Unknown';
      
      if (!timeline[key]) {
        timeline[key] = 0;
        genreTimeline[key] = {};
        artistTimeline[key] = {};
      }
      timeline[key]++;
      if (!genreTimeline[key][genre]) genreTimeline[key][genre] = 0;
      genreTimeline[key][genre]++;
      if (!artistTimeline[key][artist]) artistTimeline[key][artist] = 0;
      artistTimeline[key][artist]++;
    });

    const sortedKeys = Object.keys(timeline).sort();
    return {
      labels: sortedKeys,
      values: sortedKeys.map(k => timeline[k]),
      genreData: genreTimeline,
      artistData: artistTimeline
    };
  }
};

module.exports = lastfm;
