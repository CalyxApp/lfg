// ReportOverlay — the report reader plus the vault-link behaviour. Renders the
// report in the shared HtmlViewerOverlay, listens for the `calyx-open-vault`
// message the report iframe posts when a vault chip is tapped (injected by the
// server, see src/reports.ts), and stacks a VaultFileOverlay on top to open the
// file. While a file is open the report's Escape is suppressed so a single back
// gesture pops the file first, then the report.

import { useEffect, useState } from "react";
import { HtmlViewerOverlay } from "./HtmlViewerOverlay";
import { VaultFileOverlay } from "./VaultFileOverlay";

export function ReportOverlay({
  report,
  onClose,
}: {
  report: { title: string; url: string; repo?: string };
  onClose: () => void;
}) {
  const [vaultPath, setVaultPath] = useState<string | null>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; path?: string } | null;
      if (d && d.type === "calyx-open-vault" && typeof d.path === "string" && d.path) {
        setVaultPath(d.path);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const repo = report.repo || "PlatosRaveCave";

  return (
    <>
      <HtmlViewerOverlay
        title={report.title}
        src={report.url}
        onClose={onClose}
        escEnabled={!vaultPath}
      />
      {vaultPath ? (
        <VaultFileOverlay repo={repo} path={vaultPath} onClose={() => setVaultPath(null)} />
      ) : null}
    </>
  );
}
