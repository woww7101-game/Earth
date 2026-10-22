# TerraWeather

Responsive globe + weather explorer starter built with FastAPI, MongoDB, CesiumJS, OpenWeather and Groq. This is an MVP foundation; test credentials and production hardening before public use.

## Render
- Build: `pip install -r requirements.txt`
- Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`

Environment variables:
- `MONGODB_URI` — MongoDB Atlas connection string
- `MONGODB_DB_NAME` — database name (default `terraweather`)
- `SECRET_KEY` — long random secret
- `GROQ_API_KEY`
- `OPENWEATHER_API_KEY`
- `CESIUM_ION_TOKEN` — Cesium ion token with appropriate assets/terrain access
- optional `GROQ_MODEL` (default `llama-3.3-70b-versatile`)
- optional `OPENWEATHER_TILE_LAYER` (default `temp_new`)

OpenWeather map tiles may require an eligible API subscription and are subject to provider availability/terms. The map's heat layer is a temperature overlay, not a medical/official warning layer. Cesium imagery and terrain access depend on the ion token and asset permissions.
