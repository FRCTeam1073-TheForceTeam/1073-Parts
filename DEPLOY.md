# Putting 1073 Parts online (Fly.io)

Cost: roughly $3–5/month. The app sleeps when nobody is using it and wakes in a second or two on the next visit.

## One-time setup

1. **Create a Fly.io account** at <https://fly.io/app/sign-up> and add a payment card.
2. **Install the Fly command-line tool** (PowerShell):

   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```

   Close and reopen the terminal afterwards so `fly` is on the path.
3. **Sign in**: `fly auth login` (opens the browser).
4. **Create the app, its disk, and deploy**, from the `parts-tracker` folder:

   ```bash
   fly apps create frc1073-parts          # if the name is taken, pick another and change `app` in fly.toml
   fly volumes create parts_data --region bos --size 1 --yes
   fly secrets set SETUP_CODE="<something only you know>"
   fly deploy
   ```

   The site is now at `https://frc1073-parts.fly.dev`. `SETUP_CODE` means nobody can create the first admin account without it.

## Moving the current data over

Run these from the `parts-tracker` folder, on the computer that has the data:

```bash
npm run backup                         # writes backup.tar (database, photos, part files)
fly ssh sftp shell                     # then, at the sftp prompt:
  put backup.tar /data/restore.tar
  exit
fly apps restart frc1073-parts
```

On restart the server loads `restore.tar` before opening the database, then renames it so it only happens once. Everyone signs in with their existing accounts.

## Updating after changes

```bash
fly deploy
```

Data on the disk is kept between deploys.

## Backups

- Fly snapshots the disk every day and keeps 5 days (`fly volumes snapshots list`).
- Admins can download a full backup any time from **Settings → Backup**. Keep copies somewhere else, like the team Google Drive.
- To restore a backup on the server, upload it as `/data/restore.tar` (same as moving data, above) and restart.

## Useful commands

| Command | What it does |
| --- | --- |
| `fly logs` | Live server logs |
| `fly status` | Is it running, which machine |
| `fly ssh console` | Shell on the server |
| `fly secrets set NAME=value` | Change a setting (restarts the app) |
