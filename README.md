# Order Entry — Frontend

The mobile order-entry app (New Order / Inventory / Orders tabs), built with
React + Vite. It talks to your live backend at
`https://ordering-app-ycc9.onrender.com`.

## Run it locally (optional, to try before deploying)

```
npm install
npm run dev
```

Opens at `http://localhost:5173`. Since it's a static site talking to your
already-live backend, this will show real data even running locally.

## Deploying to Render as a Static Site

This is simpler than the backend deploy — static sites don't need a disk,
an environment variable, or a paid tier. Free works fine here.

1. **Push this folder to a new GitHub repo**, the same way you did for the
   backend (Add file → Create new file → type `src/App.jsx` as the filename
   to recreate folder structure, or use git if you're comfortable with it).
   Make sure these end up in the repo:
   - `package.json`
   - `vite.config.js`
   - `index.html`
   - `src/main.jsx`
   - `src/App.jsx`

2. In Render, click **New → Static Site** (not "Web Service" this time —
   that's what caused the confusion before; a static site is a different
   option in the same menu).

3. Connect the new GitHub repo.

4. Set:
   - **Build command:** `npm install && npm run build`
   - **Publish directory:** `dist`

5. Deploy. Render will give you a URL like
   `https://ordering-app-frontend-xxxx.onrender.com` — that's the address
   your sales team opens on their phones.

6. Test it: open that URL, confirm it loads real customers/items (not
   "Couldn't reach the server"), and try placing a test order.

## Why this one's simpler than the backend

Static sites are just files (HTML/CSS/JS) served as-is — there's no server
process running, so nothing to sleep, no disk needed, and no environment
variables required. The frontend already has your backend's URL built in.

## Note on the backend URL

The backend URL is currently hardcoded in `src/App.jsx` (`const API_BASE = ...`).
If your backend's URL ever changes, that line needs to be updated and the
site rebuilt/redeployed.
