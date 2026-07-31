# TechPulse Intelligence — Render Deployment Guide

## Quick Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Omogbolahan33/TechPulse-Intelligence)

## Manual Deployment Steps

### 1. Create a New Web Service

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New +** → **Web Service**
3. Connect your GitHub repository
4. Configure the service:
   - **Name**: `techpulse-intelligence`
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Plan**: Free (or your preferred plan)

### 2. Set Environment Variables

In the Render Dashboard, go to your service → **Environment** → **Add Environment Variable**:

| Key | Required | Description |
|-----|----------|-------------|
| `NODE_ENV` | Yes | Set to `production` |
| `GEMINI_API_KEY` | Yes* | Primary AI provider (free tier available) |
| `GROQ_API_KEY` | No | Fast inference backup |
| `OPENAI_API_KEY` | No | GPT-4o backup |
| `ANTHROPIC_API_KEY` | No | Claude backup |
| `OPENROUTER_API_KEY` | No | Universal aggregator + search |

*At least one AI provider key is required for AI features.

### 3. Deploy

Click **Create Web Service**. Render will:
1. Install dependencies
2. Build the production bundle
3. Start the server

Your app will be live at `https://techpulse-intelligence.onrender.com`

## Environment Variables

### Required

```bash
NODE_ENV=production
GEMINI_API_KEY=your-key-here
```

### Optional (AI Provider Backups)

```bash
GROQ_API_KEY=your-key-here
OPENAI_API_KEY=your-key-here
ANTHROPIC_API_KEY=your-key-here
OPENROUTER_API_KEY=your-key-here
```

## Health Check

Render uses `/api/health` as the health check endpoint. It returns:
```json
{"status": "ok"}
```

## Troubleshooting

### Build Fails
- Ensure `NODE_ENV` is set to `production`
- Check that all dependencies are in `package.json`

### AI Features Not Working
- Verify at least one AI provider key is set
- Check Render logs for provider initialization errors
- Visit `/api/ai/diagnostics` to see provider status

### Service Won't Start
- Check that `PORT` environment variable is available (Render sets this automatically)
- Verify the build output exists in `dist/`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/news` | GET | Fetch news (query: category, region) |
| `/api/news/:id/synthesis` | GET | Get article synthesis |
| `/api/ai/news/generate` | POST | Generate news with AI |
| `/api/ai/search` | POST | Search news with AI |
| `/api/ai/synthesis` | POST | Generate article synthesis |
| `/api/ai/extras` | POST | Generate quiz, flashcards, scripts |
| `/api/ai/chat` | POST | Chat with AI |
| `/api/ai/tts` | POST | Text-to-speech |
| `/api/ai/diagnostics` | GET | AI provider diagnostics |
| `/api/metadata` | GET | Fetch URL metadata |
| `/api/admin/diagnostics` | GET | Server diagnostics |

## Architecture

```
Client (React + Vite)
    ↓ HTTP requests
Server (Express + tsx)
    ↓ AI API calls
AI Providers (Gemini, Groq, OpenAI, Anthropic, OpenRouter)
    ↓ Results cached
Firebase Firestore
```

## Support

For issues, visit: https://github.com/Omogbolahan33/TechPulse-Intelligence/issues
