/**
 * SQNR mark — an isometric wireframe cube with three axis vectors radiating
 * from its center. Drawn as inline SVG so it stays crisp at any size and can
 * carry a light-blue glow under the white strokes without a raster halo.
 */
export function SqnrGlyph({ className = "size-7" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g
        style={{
          filter:
            "drop-shadow(0 0 1.6px hsl(199 90% 62% / 0.95)) drop-shadow(0 1px 2.4px hsl(199 90% 55% / 0.55))",
        }}
      >
        {/* cube shell */}
        <path d="M12 1.6 21 6.8v10.4L12 22.4 3 17.2V6.8Z" />
        {/* three visible interior edges meeting at the center */}
        <path d="M12 12 3 6.8M12 12l9-5.2M12 12v10.4" opacity="0.85" />
        {/* axis vectors */}
        <path d="M12 12V3.2" />
        <path d="m10.4 4.7 1.6-1.6 1.6 1.6" />
        <path d="M12 12 4.9 16.1" />
        <path d="m7 15.6-2.1.5.5 2.1" />
        <path d="M12 12l7.1 4.1" />
        <path d="m17 15.6 2.1.5-.5 2.1" />
      </g>
    </svg>
  );
}

export function BrandMark({ variant = "light" }: { variant?: "light" | "dark" }) {
  void variant;
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-[11px] bg-foreground text-background">
        <SqnrGlyph className="size-6" />
      </span>
      <span className="text-[21px] font-semibold tracking-tight text-foreground">SQNR</span>
    </span>
  );
}
