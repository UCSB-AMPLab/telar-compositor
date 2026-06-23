/**
 * Footer — project attribution and version.
 *
 * Charcoal background with cream text. Links to Neogranadina and AMPL.
 * Version number aligned right. Internationalised.
 */

import { Trans, useTranslation } from "react-i18next";

interface FooterProps {
  className?: string;
}

const VERSION = "1.3.9-beta";

const linkClass = "text-cream/60 hover:text-cream hover:underline underline-offset-2";

export function Footer({ className = "" }: FooterProps) {
  useTranslation("common");

  return (
    <footer
      className={`h-10 flex items-center justify-between px-6 text-xs font-body text-cream/60 bg-charcoal shrink-0 ${className}`}
    >
      <span>
        <Trans
          i18nKey="footer.attribution"
          ns="common"
          components={{
            neo: <a href="https://neogranadina.org" target="_blank" rel="noopener noreferrer" className={linkClass} />,
            ampl: <a href="https://ampl.clair.ucsb.edu" target="_blank" rel="noopener noreferrer" className={linkClass} />,
          }}
        />
      </span>
      <span className="shrink-0 ml-4 text-cream/40">v{VERSION}</span>
    </footer>
  );
}
