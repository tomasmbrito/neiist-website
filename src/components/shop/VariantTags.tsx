import { isColorKey } from "@/utils/shop/shopUtils";

interface VariantTagsProps {
  options?: Record<string, string>;
  className?: string;
}

export default function VariantTags({ options, className }: VariantTagsProps) {
  if (!options) return null;

  const nonColorEntries = Object.entries(options).filter(([k]) => !isColorKey(k));
  if (nonColorEntries.length === 0) return null;

  return (
    <>
      {nonColorEntries.map(([k, v]) => (
        <span className={className} key={k}>
          {`${k.trim()}: ${v}`}
        </span>
      ))}
    </>
  );
}
