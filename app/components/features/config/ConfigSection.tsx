/**
 * ConfigSection — card wrapper for a config section in the editor.
 */

interface ConfigSectionProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

export function ConfigSection({ title, children, className = "" }: ConfigSectionProps) {
  return (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6 ${className}`}>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-4">{title}</h2>
      {children}
    </div>
  );
}
