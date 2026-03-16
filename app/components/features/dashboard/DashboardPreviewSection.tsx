/**
 * DashboardPreviewSection — wrapper for each site preview section on the dashboard.
 *
 * Renders the compositor heading and explanatory text on the grey page background,
 * with user content inside a white frame that highlights with a periwinkle border
 * on hover to signal editability.
 */

interface DashboardPreviewSectionProps {
  heading: string;
  explanation: string;
  children: React.ReactNode;
  className?: string;
}

export function DashboardPreviewSection({
  heading,
  explanation,
  children,
  className = "",
}: DashboardPreviewSectionProps) {
  return (
    <div className={className}>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-1">{heading}</h2>
      <p className="font-body text-sm text-gray-500 mb-3">{explanation}</p>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 hover:border-periwinkle transition-colors cursor-pointer">
        {children}
      </div>
    </div>
  );
}
