import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Helper to parse duration string "MM:SS" or "HH:MM:SS" to seconds
function parseDurationSec(durationStr?: string): number {
  if (!durationStr) return 210;
  const parts = durationStr.split(':').map((p) => parseInt(p, 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 210;
}

// Estimate BPM based on musical keywords
function estimateBpm(title: string, channel: string): number {
  const text = `${title} ${channel}`.toLowerCase();
  if (text.includes('dnb') || text.includes('drum and bass') || text.includes('drum & bass')) return 174;
  if (text.includes('dubstep')) return 140;
  if (text.includes('hardstyle')) return 150;
  if (text.includes('techno') || text.includes('trance')) return 132;
  if (text.includes('house') || text.includes('edm') || text.includes('club')) return 126;
  if (text.includes('disco') || text.includes('funk')) return 118;
  if (text.includes('hip hop') || text.includes('rap') || text.includes('trap')) return 92;
  if (text.includes('r&b') || text.includes('reggae') || text.includes('reggaeton')) return 96;
  if (text.includes('ambient') || text.includes('chill') || text.includes('lofi')) return 85;
  // Default dancefloor friendly BPM
  return 124;
}

// Estimate harmonic key for DJing
const CAMELOT_KEYS = [
  '1A / Abm', '1B / B Maj', '2A / Ebm', '2B / F# Maj', '3A / Bbm', '3B / Db Maj',
  '4A / Fm', '4B / Ab Maj', '5A / C#m', '5B / E Maj', '6A / G#m', '6B / B Maj',
  '7A / Dm', '7B / F Maj', '8A / Am', '8B / C Maj', '9A / Em', '9B / G Maj',
  '10A / Bm', '10B / D Maj', '11A / F#m', '11B / A Maj', '12A / C#m', '12B / E Maj',
];

function estimateKey(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % CAMELOT_KEYS.length;
  return CAMELOT_KEYS[idx];
}

// YouTube Search API endpoint
app.get('/api/search', async (req, res) => {
  const query = (req.query.q as string || '').trim();
  if (!query) {
    return res.json({ results: [] });
  }

  // 1. Direct YouTube link or isolated 11-char ID
  let directVideoId: string | null = null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(query)) {
    directVideoId = query;
  } else {
    const urlMatch = query.match(/^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (urlMatch && urlMatch[2]) {
      directVideoId = urlMatch[2];
    }
  }

  if (directVideoId) {
    return res.json({
      results: [
        {
          id: `yt-${directVideoId}`,
          videoId: directVideoId,
          title: `YouTube Video (${directVideoId})`,
          artist: 'Direct YouTube Link',
          thumbnailUrl: `https://i.ytimg.com/vi/${directVideoId}/hqdefault.jpg`,
          duration: 240,
          durationFormatted: '4:00',
          bpm: 124,
          key: '8A / Am',
          genre: 'Direct Video',
          suggestedCue: 0,
        },
      ],
    });
  }

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const html = await response.text();
    const match =
      html.match(/ytInitialData\s*=\s*({.+?});<\/script>/s) ||
      html.match(/var ytInitialData\s*=\s*({.+?});/s);

    if (match) {
      const data = JSON.parse(match[1]);
      const contents =
        data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

      const rawItems: any[] = [];
      for (const section of contents) {
        const itemContents = section.itemSectionRenderer?.contents || [];
        for (const item of itemContents) {
          if (item.videoRenderer) {
            rawItems.push(item.videoRenderer);
          }
        }
      }

      const results = rawItems.slice(0, 15).map((v) => {
        const videoId = v.videoId;
        const title = v.title?.runs?.[0]?.text || v.title?.simpleText || 'YouTube Track';
        const channel = v.ownerText?.runs?.[0]?.text || 'YouTube Creator';
        const durationFormatted = v.lengthText?.simpleText || '3:30';
        const duration = parseDurationSec(durationFormatted);
        const bpm = estimateBpm(title, channel);
        const key = estimateKey(title + channel);

        // Best thumbnail URL
        const thumb =
          v.thumbnail?.thumbnails?.[v.thumbnail.thumbnails.length - 1]?.url ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        return {
          id: `yt-${videoId}`,
          videoId,
          title,
          artist: channel,
          thumbnailUrl: thumb.startsWith('//') ? `https:${thumb}` : thumb,
          duration,
          durationFormatted,
          bpm,
          key,
          genre: 'YouTube Music',
          suggestedCue: 0,
        };
      });

      if (results.length > 0) {
        return res.json({ results });
      }
    }
  } catch (err) {
    console.warn('Error fetching YouTube search:', err);
  }

  // Fallback to empty results if no match
  return res.json({ results: [] });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// Vite Middleware Setup for Dev Server & Production Static
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  if (!isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DJ YouTube Mashup server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
