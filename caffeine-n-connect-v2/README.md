# Caffeine n Connect v2

Hackathon-ready full-stack prototype using HTML/CSS/JavaScript + Node/Express + a JSON-file database. This version intentionally avoids native SQLite modules, so it works on modern Node without node-gyp.

## Features
- Empty database on first launch (no seeded/demo rows)
- Signup/login/logout with hashed passwords and sessions
- Editable user profile and skills
- Portfolio add/delete
- Services: create, edit, pause, delete (ownership enforced server-side)
- Search/filter + keyword match score
- Reputation reviews
- Advanced 1-to-1 messaging: conversation inbox, unread counts, timestamps, read receipts, reply, edit, delete, attachments, service-context conversations, Socket.IO updates
- Communities: create/join and group chat
- Responsive coffee-themed UI

## Run
1. Install Node.js (Node 22 or 24 is fine for this version).
2. Extract the ZIP and open the folder in VS Code.
3. Run:
   npm install
   npm start
4. Open http://localhost:3000

## Empty database
`data/db.json` ships with empty arrays. Do not add demo data if you want a clean first launch. To reset during development, stop the server and replace `data/db.json` with the original empty object from the ZIP.

## Demo messaging
To test messaging locally, create two accounts using two different browsers/incognito windows, then find the other user via a service/profile and click Message.

## Important production note
This is a hackathon prototype. The JSON database and default in-memory session store are not intended for production or multi-instance Vercel hosting. For production, move data/auth/storage/realtime to PostgreSQL/Supabase or a similar hosted service and set a strong SESSION_SECRET.

## v2.1 interface updates
- Login/sign-up uses the supplied Caffeine n Connect logo and tagline artwork.
- Profile skills use a searchable alphabetical multi-select list instead of free typing.
- Service skills use the same standardized skill selector for reliable matching.
- Service category is a predefined alphabetical dropdown.
- The large coffee mug illustration was removed from the home hero.
- `data/db.json` is shipped empty (schema collections only).
