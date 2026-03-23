const axios = require('axios');
const { Scrobble, ArtistGenre, sequelize } = require('./db');
const { Op } = require('sequelize');
require('dotenv').config();

const API_KEY = process.env.LASTFM_API_KEY;
const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

const lastfm = {
  /**
   * Internal helper to handle Axios requests with retry logic
   */
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
   * Fetch top tags (genres) for a specific user based on their top artists.
   */
  async getTopTags(user, period = '7day', limit = 10) {
    try {
      const dbScrobbles = await Scrobble.findAll({
        attributes: [
            'artist',
            [sequelize.fn('COUNT', sequelize.col('uts')), 'playcount']
        ],
        where: { user },
        group: ['artist'],
        order: [[sequelize.literal('playcount'), 'DESC']],
        limit: 10
      });

      const tagsMap = {};
      
      // Process the top artists from DB to get real tags
      const artistsTagsData = await Promise.all(
        dbScrobbles.map(a => this.getArtistPrimaryGenre(a.artist))
      );

      dbScrobbles.forEach((artist, index) => {
        const genre = artistsTagsData[index];
        const playcount = parseInt(artist.dataValues.playcount);
        
        if (genre !== 'Other') {
          if (!tagsMap[genre]) tagsMap[genre] = 0;
          tagsMap[genre] += playcount; 
        }
      });

      return Object.entries(tagsMap)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
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
   * Get real tags for an artist from Last.fm
   */
  async getArtistTags(artist) {
    try {
      const response = await this._request({
          method: 'artist.gettoptags',
          artist,
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

  /**
   * Get primary genre for an artist, using local DB as first-level cache
   */
  async getArtistPrimaryGenre(artistName) {
    // 1. Check Local DB
    const localEntry = await ArtistGenre.findByPk(artistName);
    if (localEntry) return localEntry.genre;

    // 2. Fetch from Last.fm if not found locally
    // console.log(`[Genre] Fetching real tags for ${artistName}...`);
    const tags = await this.getArtistTags(artistName);

    // Whitelist for prioritization and normalization
    const genreWhitelist = {
        'rock': 'Rock', 'classic rock': 'Rock', 'pop rock': 'Rock', 'indie rock': 'Indie', 'alternative rock': 'Indie', 'punk': 'Punk', 'hard rock': 'Rock', 'heavy metal': 'Metal', 'metal': 'Metal',
        'k-pop': 'K-Pop', 'kpop': 'K-Pop', 'korean': 'K-Pop', 'j-pop': 'J-Pop', 'jpop': 'J-Pop', 'japanese': 'J-Pop',
        'pop': 'Pop', 'dance-pop': 'Pop', 'synthpop': 'Pop',
        'hip hop': 'Hip-Hop', 'rap': 'Hip-Hop', 'trap': 'Hip-Hop', 'r&b': 'R&B', 'soul': 'R&B', 
        'mpb': 'MPB', 'brazilian': 'MPB', 'samba': 'MPB', 'bossa nova': 'MPB', 'sertanejo': 'Sertanejo',
        'electronic': 'Electronic', 'house': 'Electronic', 'techno': 'Electronic', 'dance': 'Electronic', 'ambient': 'Electronic', 'lo-fi': 'Lo-Fi', 'lofi': 'Lo-Fi',
        'jazz': 'Jazz', 'blues': 'Blues', 'country': 'Country', 'folk': 'Folk', 'indie': 'Indie', 'alternative': 'Indie',
        'soundtrack': 'OST', 'ost': 'OST', 'score': 'OST', 'classical': 'Classical'
    };

    let genre = 'Other';

    if (tags && tags.length > 0) {
        // Find the best match from the whitelist
        for (const tag of tags) {
            const tagName = (tag.name || tag['#text'] || '').toLowerCase();
            if (!tagName) continue;

            // Try exact match or partial match
            for (const [key, value] of Object.entries(genreWhitelist)) {
                if (tagName === key || tagName === key.replace('-', ' ') || tagName.includes(key)) {
                    genre = value;
                    break;
                }
            }
            if (genre !== 'Other') break;
        }

        // Fallback: If no whitelist match, use the first tag if it's not in blacklist
        if (genre === 'Other') {
            const blacklist = ['seen live', 'favorites', 'awesome', 'cool', 'radio', 'under 2000', 'under 100', 'under 500', 'various artists', 'male vocalists', 'female vocalists'];
            const firstValid = tags.find(t => {
                const name = (t.name || t['#text'] || '').toLowerCase();
                return name && !blacklist.some(b => name.includes(b));
            });
            if (firstValid) genre = firstValid.name || firstValid['#text'];
        }
    }

    // 3. Save to local DB for next time
    try {
        await ArtistGenre.upsert({ artist: artistName, genre });
    } catch (e) {
        // console.error("DB Save genre error", e.message);
    }

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

    // To get all genres, we need to check the DB for all artists in the tracks
    const uniqueArtistsInPeriod = [...new Set(tracks.map(t => t.artist))];
    
    // Fetch all genres from DB at once if possible
    const localGenres = await ArtistGenre.findAll({
        where: { artist: { [Op.in]: uniqueArtistsInPeriod } }
    });
    
    const artistGenres = {};
    localGenres.forEach(ag => {
        artistGenres[ag.artist] = ag.genre;
    });

    // For any artist not in DB, we fetch it (this will also save to DB)
    // We limit this to avoid spamming the API if many are missing
    const missingArtists = uniqueArtistsInPeriod.filter(a => !artistGenres[a]);
    const artistsToFetch = missingArtists.slice(0, 50); // Fetch up to 50 missing per request

    await Promise.all(artistsToFetch.map(async name => {
        artistGenres[name] = await this.getArtistPrimaryGenre(name);
    }));

    tracks.forEach(track => {
      const key = groupKeyFn(track.date_str);
      const genre = artistGenres[track.artist] || 'Other';
      
      if (!timeline[key]) {
        timeline[key] = 0;
        genreTimeline[key] = {};
      }
      timeline[key]++;
      if (!genreTimeline[key][genre]) genreTimeline[key][genre] = 0;
      genreTimeline[key][genre]++;
    });

    const sortedKeys = Object.keys(timeline).sort();
    return {
      labels: sortedKeys,
      values: sortedKeys.map(k => timeline[k]),
      genreData: genreTimeline
    };
  },

  /**
   * Fetch weekly track chart (for temporal analysis)
   */
  async getWeeklyTrackChart(user) {
    try {
      const response = await axios.get(BASE_URL, {
        params: {
          method: 'user.getweeklytrackchart',
          user,
          api_key: API_KEY,
          format: 'json'
        }
      });
      return response.data.weeklytrackchart ? response.data.weeklytrackchart.track : [];
    } catch (error) {
      console.error(`Error fetching weekly track chart for ${user}:`, error.message);
      return [];
    }
  },

  /**
   * Aggregate data for a group or specific user with defined period.
   */
  async getAdvancedData(users = [], period = '7day') {
    const results = {};
    for (const user of users) {
      const [artists, tracks, tags] = await Promise.all([
        this.getTopArtists(user, period, 10),
        this.getTopTracks(user, period, 10),
        this.getTopTags(user, period, 10)
      ]);
      results[user] = { artists, tracks, tags };
    }
    return results;
  }
};

module.exports = lastfm;
