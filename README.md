# Hakui

Hakui is a mobile-first, offline-capable bookkeeping application for a Japan trip. It stores money as integer JPY, tracks Osaka, Kyoto, and Tokyo separately, scans Japanese receipts on a self-hosted NixOS host, and keeps pre-trip purchases outside the live budget gauges.

## Local development

Requirements are provided by the flake:

```sh
nix develop
npm install
npm run dev:backend
npm run dev
```

Run the two development commands in separate terminals, then open `http://127.0.0.1:5173`. The development database is created at `data/hakui.sqlite`, and `CurrentFinances.csv` is imported automatically only when the database has no transactions.

Useful checks:

```sh
npm run check
npm test
npm run build
nix flake check
```

## Configuration

`config/hakui.json` is suitable for local development. `config/hakui.production.example.json` is configured for `https://hakui.kaitotlex.systems`. Keep production database, backup, and initial CSV paths under `/var/lib/hakui` so systemd hardening permits access.

Budget amounts and leg dates are set in the application Settings page, not in JSON.

## NixOS deployment

Add this flake as an input and import its module:

```nix
{
  inputs.hakui.url = "path:/path/to/hakui";

  outputs = { nixpkgs, hakui, ... }: {
    nixosConfigurations.server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        hakui.nixosModules.default
        ({ ... }: {
          services.hakui = {
            enable = true;
            configFile = /etc/nixos/hakui.json;
          };
        })
      ];
    };
  };
}
```

The module runs an isolated Svelte frontend on `127.0.0.1:3004` and Python API on `127.0.0.1:3005` (or the ports configured in `configFile`). Only proxy the frontend port. Rebuild NixOS, then inspect:

```sh
systemctl status hakui
systemctl status hakui-api
curl http://127.0.0.1:3004/api/health
```

Put your own reverse proxy (nginx, Caddy, Tailscale Serve, whatever you already run) in front of `127.0.0.1:3004` if you want it reachable off the box, and terminate TLS there however you normally do. This deployment intentionally has no application authentication, so anyone who can reach it can view and modify its financial data — keep it behind whatever access control your proxy provides.

## Offline behavior

Visit every main page once while online, then install Hakui to the phone home screen. Transactions and compressed receipt images are written to IndexedDB before network access is attempted. Synchronization retries on startup, reconnect, foreground activation, or the visible Sync button. Receipt OCR starts only after the server receives a queued image.

Browser storage is not a backup. Daily SQLite backups are retained by the NixOS module, and the Settings page can export transactions as CSV.

## Receipt processing

The Python service owns SQLite, CSV import, ImageMagick/Tesseract OCR, receipt parsing, and CTranslate2 translation. OCR work is persisted before processing and interrupted jobs return to the queue after a restart. Translation runs only as a fallback and never changes a numeric value. The Svelte service only renders and proxies the website; if Python is unavailable it serves the offline shell instead of failing the whole site.
