# Hakui

Hakui is a mobile-first, offline-capable bookkeeping application for a Japan trip. It stores money as integer JPY, tracks Osaka, Kyoto, and Tokyo separately, scans Japanese receipts on a private NixOS host, and keeps pre-trip purchases outside the live budget gauges.

## Local development

Requirements are provided by the flake:

```sh
nix develop
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The development database is created at `data/hakui.sqlite`, and `CurrentFinances.csv` is imported automatically only when the database has no transactions.

Useful checks:

```sh
npm run check
npm test
npm run build
nix flake check
```

## Configuration

`config/hakui.json` is suitable for local development. For NixOS, start from `config/hakui.production.example.json` and set the exact HTTPS Tailscale origin. Keep production database, backup, and initial CSV paths under `/var/lib/hakui` so systemd hardening permits access.

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
          services.tailscale.enable = true;
          services.hakui = {
            enable = true;
            configFile = /etc/nixos/hakui.json;
            tailscaleServe.enable = true;
          };
        })
      ];
    };
  };
}
```

Rebuild NixOS, then inspect:

```sh
systemctl status hakui
curl http://127.0.0.1:3000/api/health
tailscale serve status
```

Do not open the application port in the firewall and do not enable Tailscale Funnel. Tailscale Serve supplies the HTTPS secure context required by phone camera and PWA features while keeping the site private to the tailnet.

## Offline behavior

Visit every main page once while online, then install Hakui to the phone home screen. Transactions and compressed receipt images are written to IndexedDB before network access is attempted. Synchronization retries on startup, reconnect, foreground activation, or the visible Sync button. Receipt OCR starts only after the server receives a queued image.

Browser storage is not a backup. Daily SQLite backups are retained by the NixOS module, and the Settings page can export transactions as CSV.

## Receipt processing

The flake packages ImageMagick, Tesseract with `jpn+eng`, CTranslate2, SentencePiece, and a pinned Japanese-to-English model. OCR checks Japanese total labels first. Translation runs only as a fallback and never changes a numeric value. Every scanned transaction remains marked for review until it is opened and saved by the user.
