# Notes App — PRD / Handoff Memory

## Product
100% offline Notes mobile app (Expo Router + React Native). No backend dependency for features.
- Storage: expo-sqlite on native, AsyncStorage on web (`src/db/*`, `src/utils/storage/*`)
- Features: notes CRUD w/ autosave, checklists, favorites, pinned, archive, trash/restore,
  folders, labels, search/sort, drawing, image attachments (base64), voice notes (expo-audio),
  biometric lock (expo-local-authentication), backup/export, Share note (text / picture / Markdown),
  dark & light theme, ErrorBoundary crash resilience.
- Backend (`backend/server.py`): FastAPI template only (`/api/` hello + `/api/status`). Not used by the app.

## Key files
- Routes: `frontend/app/*` (index, editor, settings, folders, labels, folder/[id], label/[id], drawing, image-viewer)
- State: `frontend/src/context/AppContext.tsx`
- Components: `frontend/src/components/*` (Sheet, NoteCard, NotesGrid, Toast, LockGate, ...)
- Share logic: `frontend/src/lib/share.ts`, exporter: `frontend/src/lib/exporter.ts`

## Environment notes
- `.env` files are gitignored and get lost on fork/resume. Recreate:
  - `frontend/.env`: EXPO_PUBLIC_BACKEND_URL / EXPO_PACKAGER_PROXY_URL / EXPO_PACKAGER_HOSTNAME (preview URL from supervisor conf)
  - `backend/.env`: MONGO_URL="mongodb://localhost:27017", DB_NAME="test_database", CORS_ORIGINS="*"
- Services: `sudo supervisorctl restart expo backend`. Expo on :3000, backend on :8001.

## Status
- All audited flows passed testing (see test_result.md). App restarted and verified on 2026-09-06.
- No auth in app -> `test_credentials.md` not needed.
