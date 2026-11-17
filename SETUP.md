# Setting up Corner (for Tayla)

You do this **once**. It takes about 20 minutes. You need a computer (not a phone) for it.

There are three parts:
1. **GitHub** holds the app's code and turns it into a web address.
2. **Supabase** holds the locked data, so devices can sync.
3. **Sharing:** send your friend the link and their guide.

---

## Part 1: GitHub (about 10 min)

### 1a. Protect your account (important)
Whoever controls this GitHub account controls the app's code. Turn on two-factor sign-in:
GitHub → your photo (top right) → **Settings** → **Password and authentication** → **Enable two-factor authentication**.

### 1b. Make the project
1. Go to <https://github.com/new>.
2. **Repository name:** `corner`
3. Choose **Public**. Only code goes here, never anyone's data. A private project needs a paid plan for the web address.
4. Leave everything else as it is. Click **Create repository**.

### 1c. Upload the files
1. On the new, empty project page, click the link **"uploading an existing file"**.
2. Unzip `corner-site.zip` (double-click it). Open the folder it makes, select **everything inside** (all files and folders, including `vendor` and `_tools`), and drag it into the browser.
   - On a Mac, the `.nojekyll` file is hidden. Press **⌘ Shift .** in Finder to show hidden files so it gets included. If it's missed, nothing breaks.
3. Click **Commit changes** at the bottom.

### 1d. Turn on the web address
1. In the project, go to **Settings** → **Pages** (left side).
2. Under **Build and deployment** → **Source**, choose **Deploy from a branch**.
3. **Branch:** `main`, folder `/ (root)` → **Save**.
4. Wait 1–2 minutes and refresh. You'll see **"Your site is live at `https://taylanewman.github.io/corner/`"**.

---

## Part 2: Supabase (about 10 min)

### 2a. Make the project
1. Go to <https://supabase.com> → **Start your project** and sign up. The free plan is fine.
2. Click **New project**.
   - **Name:** `corner`
   - **Database password:** click **Generate**. You won't need it for this, but save it in your password manager anyway.
   - **Region:** the one closest to you (e.g. *East US*).
3. Click **Create new project** and wait about a minute.

### 2b. Create the table
1. Left side → **SQL Editor** → **New query**.
2. Open `supabase-setup.sql` (in the folder), copy **all** of it, and paste it in.
3. Click **Run**. It should say **"Success. No rows returned."**

### 2c. Sign-in settings
1. Left side → **Authentication** → **Sign In / Providers** → **Email**.
2. Turn **Confirm email** **off**, then click **Save**. Otherwise Supabase sends a confirmation email whose link points to the wrong place.
3. Left side → **Authentication** → **URL Configuration** → **Site URL**: paste `https://taylanewman.github.io/corner/` → **Save**.

### 2d. Copy the two codes
Left side → **Project Settings** (gear) → **API** (or **Data API** / **API Keys**). Copy:
- **Project URL**, which looks like `https://abcdefgh.supabase.co`
- **Publishable key** (also called the **anon public** key)

⚠️ **Never** use the key labelled **secret** or **service_role**.

These two codes only say *where* the locked data lives. They can't unlock anything.

**Optional, so your friend doesn't have to paste them:** on GitHub, open `config.js` → pencil ✏️ (Edit) → put the two codes between the quotes → **Commit changes**.

```js
window.CORNER_CONFIG = {
  url: 'https://abcdefgh.supabase.co',
  anonKey: 'sb_publishable_…'
};
```

### 2e. After your friend has made their account
Close the door to strangers: **Authentication** → **Sign In / Providers** → turn **Allow new users to sign up** **off** → **Save**.
(Anyone signing up would only get their own empty locked space, but there's no reason to allow it.)

### Good to know: the free plan pauses
Supabase pauses free projects that **nobody uses for 7 days**. Everyday use keeps it awake. If it ever pauses, sign in to Supabase and click **Restore project**. Nothing is lost.

---

## Part 3: Share it
Send your friend:
1. The link: `https://taylanewman.github.io/corner/`
2. `FRIEND-GUIDE.md` (or just its text)
3. The two codes from 2d, **only if** you didn't put them in `config.js`

---

## Updating later

When you want the friend's copy to catch up with your app:
1. Ask Claude: **"make a GitHub update for Corner"**. You'll get a new `index.html` and a note on what changed.
2. On GitHub, open the `corner` project → **Add file** → **Upload files** → drag in the new `index.html` → **Commit changes**.
3. Within a couple of minutes, your friend gets it the next time they open or refresh the app. **Their data isn't touched.**

Only `index.html` changes in normal updates. Leave `private.js` and `config.js` alone unless Claude says otherwise.
