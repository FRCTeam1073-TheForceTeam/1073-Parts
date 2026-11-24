# 1073 Parts

Team website for robot parts: what to order, what to make, what's on the shelf, and the budget.

## Features

- **Orders**: add parts by searching supplier catalogs from inside the app, or by pasting a product link. Picking a variant fills in the full name (product + variant), SKU, price and link. Group by mechanism, supplier or status, and filter by any of them.
- **Custom parts and the Board**: parts made in-house (plates, tubes, prints) are tracked with part number, CAD link, material, process, quantity made, who's making it and a due date. The **Board** tab is a drag-and-drop scrum board: custom parts move through stages (Design → Ready to make → Manufacturing → Post-processing → Inspect → Done, editable in Settings), and a second board shows purchased parts as Needed → Ordered → Arrived. It also has a list view and filters by mechanism, person and process.
- **Part files and 3D viewer**: attach STEP, STL, 3MF, OBJ, DXF, G-code or PDF files to a custom part (up to 100 MB each, stored in `data/files`). STEP/STL/3MF/OBJ files open in a built-in 3D viewer (rotate, zoom, pan). Attaching a model to a part with no photo renders a picture of it for the board card, and "Use this view as the part photo" saves any angle. The viewer libraries (three.js, OpenCascade) are served from `node_modules`, so it works without internet.
- **BOM import**: paste an **Onshape assembly or Part Studio link** (after an admin connects Onshape in Settings), or import a CSV export. Each row is set to **Order**, **Make** or **Skip**:
  - Part numbers that match supplier SKUs (WCP-0940, am-3402, TTB-0347, REV-21-1650, McMaster numbers, Swyft SR-…, Last Anvil 6-digit numbers, B&B belt/pulley numbers like 300-5M-15) are matched to the exact product variant and default to **Order**, minus what's already in inventory.
  - Everything else defaults to **Make** and goes onto the manufacturing board with its material (and CAD link, from Onshape). Parts already on the board default to **Skip**.
  - Duplicate rows are combined.
- **Inventory**: shows what's on the shelf. Orders show how many you already have, and "Receive" adds an arrived order to inventory. Set a **minimum** on an item to get a low-stock warning and a one-click "Reorder low stock".
- **Approvals**: optionally require a mentor's approval for student requests, with a dollar threshold below which requests are auto-approved. Only approved parts go into carts.
- **Shipping**: when a mentor marks parts ordered, they can record the supplier order number and the tracking number. UPS, FedEx, USPS and DHL numbers become tracking links.
- **Budget**: season budget plus optional per-mechanism budgets. Shows spent, committed and remaining, by mechanism, by supplier and by month.
- **Generate cart**:

  | Supplier | Search | Cart |
  | --- | --- | --- |
  | WCP, AndyMark, The Thrifty Bot, CTRE, Redux, Last Anvil, Swerve Drive Specialties, VBeltGuys | yes | one link fills the cart (it replaces that browser's existing cart) |
  | REV, B&B Manufacturing | yes (B&B: by part number) | click "Add" once per part, all in the same tab |
  | Swyft | yes | opens each product page; add it there |
  | McMaster-Carr | paste a link | copy a list, then use "Paste part numbers and quantities" on McMaster's order page |

## Connecting Onshape

1. Sign in at [dev-portal.onshape.com/keys](https://dev-portal.onshape.com/keys) with an Onshape account that can open the team's robot documents.
2. Create an API key with **Read** permission only. Copy the access key and the secret key (the secret is shown once).
3. In the app, an admin opens **Settings → Onshape**, pastes both keys and clicks **Connect**. The app checks the keys with Onshape before saving them. They are stored only on the server.

## Accounts and roles

The first person to open the site creates the admin account. Admins add everyone else under **Settings → Team members**.

| Role | Can do |
| --- | --- |
| Student | Request parts, import BOMs, edit or delete their own requests until ordered, update inventory counts, receive orders |
| Mentor | Everything a student can, plus approve/reject, change status, build carts, record order and tracking numbers, manage mechanisms, budgets and approval rules |
| Admin | Everything, plus manage accounts |

Passwords are stored with scrypt. Sessions last 180 days, and logins are rate-limited.

## Run it

Requires Node.js 22.13 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000. Data is stored in `data/parts.db` (SQLite). Back up that file to back up everything.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where the SQLite database lives |
| `TRUST_PROXY` | *(unset)* | Set to `1` when running behind a reverse proxy that terminates HTTPS |

## Adding a supplier

Suppliers are listed in `server/suppliers.js`. A Shopify-based store only needs a new entry in `SUPPLIERS` with `platform: 'shopify'` (add `searchMode: 'catalog'` if its search endpoint is disabled), and search, variants and cart links work automatically. To check whether a store runs on Shopify, open `https://<store>/products.json` and see if it returns JSON. Add a `skuPattern` so BOM import knows which part numbers belong to it.
