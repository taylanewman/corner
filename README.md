# Corner (private version)

A personal project space: thinking webs, Today, weekly review, and more.

**Your data is private.** It's locked on your own device with your passphrase *before* it goes anywhere. The sync space only ever stores locked text. Nobody can read it without your passphrase: not the database company, not the person who set this up, and not any AI.

- **Open it:** the GitHub Pages address for this project, for example `https://taylanewman.github.io/corner/`
- **First time:** see [FRIEND-GUIDE.md](FRIEND-GUIDE.md)
- **Setting it up / updating it:** see [SETUP.md](SETUP.md)

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The app |
| `private.js` | The lock + live sync (encryption happens here, on your device) |
| `config.js` | Optional: where the sync space is. These codes can't unlock anything |
| `vendor/supabase.js` | The sync library (Supabase, MIT licence) |
| `supabase-setup.sql` | One-time setup for the sync space |
| `_tools/update_app.py` | Used to bring in new versions of the app |

No one's personal data is ever stored in this folder.
