/**
 * Footer — AMPL / Neogranadina branding.
 *
 * Compact footer matching the approved Figma design.
 * Shows "AMPL · Neogranadina" on the left, "Telar Compositor" on the right.
 */

interface FooterProps {
  className?: string;
}

export function Footer({ className = "" }: FooterProps) {
  return (
    <footer
      className={`h-12 flex items-center justify-between px-6 text-xs font-body text-gray-400 border-t border-gray-100 ${className}`}
    >
      <span>AMPL · Neogranadina</span>
      <span>Telar Compositor</span>
    </footer>
  );
}
