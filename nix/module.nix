self: { config, lib, pkgs, ... }:
let
  cfg = config.services.hakui;
  backupScript = pkgs.writeShellScript "hakui-backup" ''
    set -euo pipefail
    database="$(${pkgs.jq}/bin/jq -r '.storage.databasePath' ${cfg.configFile})"
    destination="$(${pkgs.jq}/bin/jq -r '.storage.backupDirectory' ${cfg.configFile})"
    ${pkgs.coreutils}/bin/mkdir -p "$destination"
    stamp="$(${pkgs.coreutils}/bin/date -u +%Y%m%dT%H%M%SZ)"
    ${pkgs.sqlite}/bin/sqlite3 "$database" ".backup '$destination/hakui-$stamp.sqlite'"
    ${pkgs.findutils}/bin/find "$destination" -type f -name 'hakui-*.sqlite' -mtime +${toString cfg.backupRetentionDays} -delete
  '';
  tailscaleScript = pkgs.writeShellScript "hakui-tailscale-serve" ''
    set -euo pipefail
    port="$(${pkgs.jq}/bin/jq -r '.server.port' ${cfg.configFile})"
    ${pkgs.tailscale}/bin/tailscale serve --bg "http://127.0.0.1:$port"
  '';
in {
  options.services.hakui = {
    enable = lib.mkEnableOption "Hakui trip bookkeeping";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.default;
      defaultText = lib.literalExpression "inputs.hakui.packages.${pkgs.system}.default";
      description = "Hakui package to run.";
    };
    configFile = lib.mkOption {
      type = lib.types.path;
      description = "Validated Hakui JSON configuration. Production data paths must be under /var/lib/hakui.";
    };
    backupRetentionDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 14;
      description = "Number of days to retain daily SQLite backups.";
    };
    tailscaleServe.enable = lib.mkEnableOption "private HTTPS through Tailscale Serve";
  };

  config = lib.mkIf cfg.enable {
    users.groups.hakui = {};
    users.users.hakui = {
      isSystemUser = true;
      group = "hakui";
      home = "/var/lib/hakui";
    };

    systemd.services.hakui = {
      description = "Hakui web frontend";
      wantedBy = [ "multi-user.target" ];
      wants = [ "hakui-api.service" ];
      after = [ "network.target" "hakui-api.service" ];
      environment = {
        HAKUI_CONFIG = toString cfg.configFile;
        NODE_ENV = "production";
      };
      serviceConfig = {
        Type = "simple";
        User = "hakui";
        Group = "hakui";
        ExecStart = "${cfg.package}/bin/hakui";
        Restart = "always";
        RestartSec = 3;
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        MemoryMax = "512M";
        TasksMax = 64;
      };
    };

    systemd.services.hakui-api = {
      description = "Hakui Python data and receipt processing API";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        HAKUI_CONFIG = toString cfg.configFile;
        HOME = "/var/lib/hakui";
        XDG_DATA_HOME = "/var/lib/hakui";
        XDG_CACHE_HOME = "/var/cache/hakui";
        MAGICK_TMPDIR = "/run/hakui";
      };
      preStart = ''
        ${pkgs.coreutils}/bin/install -m 0600 -C ${cfg.package}/share/hakui/CurrentFinances.csv /var/lib/hakui/CurrentFinances.csv
      '';
      serviceConfig = {
        Type = "simple";
        User = "hakui";
        Group = "hakui";
        ExecStart = "${cfg.package}/bin/hakui-api";
        WorkingDirectory = "/var/lib/hakui";
        Restart = "always";
        RestartSec = 3;
        StateDirectory = "hakui";
        CacheDirectory = "hakui";
        RuntimeDirectory = "hakui";
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        ReadWritePaths = [ "/var/lib/hakui" "/var/cache/hakui" "/run/hakui" ];
        MemoryMax = "1536M";
        TasksMax = 64;
      };
    };

    systemd.services.hakui-healthcheck = {
      description = "Check and recover the Hakui Python API";
      after = [ "hakui-api.service" ];
      serviceConfig.Type = "oneshot";
      script = ''
        port="$(${pkgs.jq}/bin/jq -r '.backend.port // (.server.port + 1)' ${cfg.configFile})"
        host="$(${pkgs.jq}/bin/jq -r '.backend.host // "127.0.0.1"' ${cfg.configFile})"
        case "$host" in *:*) host="[$host]" ;; esac
        if ! ${pkgs.curl}/bin/curl --fail --silent --show-error --max-time 10 "http://$host:$port/health" >/dev/null; then
          ${pkgs.systemd}/bin/systemctl restart hakui-api.service
        fi
      '';
    };

    systemd.timers.hakui-healthcheck = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2m";
        OnUnitActiveSec = "2m";
        Unit = "hakui-healthcheck.service";
      };
    };

    systemd.services.hakui-backup = {
      description = "Back up Hakui SQLite database";
      after = [ "hakui-api.service" ];
      serviceConfig = {
        Type = "oneshot";
        User = "hakui";
        Group = "hakui";
        ExecStart = backupScript;
        StateDirectory = "hakui";
        UMask = "0077";
      };
    };

    systemd.timers.hakui-backup = {
      wantedBy = [ "timers.target" ];
      timerConfig = { OnCalendar = "daily"; Persistent = true; RandomizedDelaySec = "15m"; };
    };

    systemd.services.hakui-tailscale-serve = lib.mkIf cfg.tailscaleServe.enable {
      description = "Expose Hakui through private Tailscale HTTPS";
      wantedBy = [ "multi-user.target" ];
      after = [ "tailscaled.service" "hakui.service" ];
      requires = [ "tailscaled.service" "hakui.service" ];
      serviceConfig = { Type = "oneshot"; ExecStart = tailscaleScript; RemainAfterExit = true; };
    };
  };
}
