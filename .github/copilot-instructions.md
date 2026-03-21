# GitHub Copilot Instructions for governed-rag-backend

This repository is a simple Node.js/Express backend with service modules in `services/`. Aim to preserve structure and keep the runtime flow in `server.js` while implementing missing logic in services.

## Project structure

- `server.js` - Express app entrypoint (`npm start` / `npm run dev`).
- `services/openaiService.js` - OpenAI API integration hooks.
- `services/searchService.js` - Retrieval/search layer.
- `services/governance.js` - policy/governance control layer.

## Essential conventions

- Single entrypoint is `server.js` (empty now, but should set up Express + routes + middleware).
- Maintain clear separation:
  - `openaiService` => external model calls + credentials from `process.env`.
  - `searchService` => query/index operations.
  - `governance` => vetting logic and safety checks.
- Minimal dependencies. Use `axios` for HTTP calls, `dotenv` for env loading.

## Build + run + debug

- `npm install`
- `npm start` runs `node server.js`
- `npm run dev` runs `nodemon server.js`
- health checks: assumed on default port 3000 (based on terminal history from user).

## Integration patterns

- Expect explicit exported functions in services, then imported by `server.js` route handlers.
- Keep async functions and error handling in each service; do not rely on unhandled promise rejections.
- Use environment variable names consistent with OpenAI patterns (e.g. `OPENAI_API_KEY`), but confirm current `.env` in dev setup.

## AI guidance for changes

- If adding routes, prefer `GET /health`, `POST /query`, and `POST /govern` style.
- Implement and unit test services via direct function exports (no framework-specific wiring required).
- Keep code minimal and explicit; this repo is small and should avoid introduce heavy OTC abstractions.

## Notes when updating

- There is currently no `.github` AI rules in this repository. New instructions should be concise and “do what the code layout implies”.
- Should the architecture expand, update with upstream path names and external integration points (e.g., vector database or OpenAI SDK).
