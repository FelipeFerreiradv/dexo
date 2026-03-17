import React from "react";

export function DexoHero() {
  const gradientVars: React.CSSProperties = {
    ["--blue-base" as string]:
      "color-mix(in oklab, #1f6fff 80%, var(--accent) 20%)",
    ["--blue-deep" as string]:
      "color-mix(in oklab, #0b1b4d 70%, var(--ring) 30%)",
    ["--blue-light" as string]:
      "color-mix(in oklab, #6dd0ff 75%, var(--primary) 25%)",
    ["--gold-base" as string]:
      "color-mix(in oklab, #f5c043 80%, var(--primary) 20%)",
    ["--gold-warm" as string]:
      "color-mix(in oklab, #ff9824 75%, var(--accent) 25%)",
    ["--shine" as string]:
      "color-mix(in oklab, #ffffff 85%, var(--foreground) 15%)",
  };

  return (
    <div
      className="relative h-[260px] w-[280px] sm:h-[300px] sm:w-[320px]"
      style={gradientVars}
    >
      <div
        className="absolute inset-[-18%] -z-20 animate-soft-pulse opacity-35 blur-2xl"
        style={{
          background:
            "radial-gradient(circle at 50% 45%, color-mix(in oklab, var(--primary) 35%, transparent), transparent 58%)",
        }}
      />
      <div
        className="absolute inset-[-26%] -z-30 animate-orbit-slow opacity-25 blur-[65px]"
        style={{
          background:
            "conic-gradient(from 120deg at 50% 50%, color-mix(in oklab, var(--accent) 48%, transparent) 0deg, color-mix(in oklab, var(--primary) 44%, transparent) 140deg, color-mix(in oklab, var(--ring) 40%, transparent) 260deg, transparent 320deg, color-mix(in oklab, var(--primary) 36%, transparent) 360deg)",
        }}
      />

      <svg
        viewBox="0 0 320 320"
        role="img"
        aria-label="Logotipo D estilizado da Dexo"
        className="relative z-10 h-full w-full drop-shadow-[0_10px_35px_rgba(0,0,0,0.35)]"
      >
        <defs>
          <linearGradient id="dBody" x1="12%" y1="8%" x2="88%" y2="84%">
            <stop offset="0%" stopColor="var(--blue-light)" />
            <stop offset="35%" stopColor="var(--blue-base)" />
            <stop offset="78%" stopColor="var(--blue-deep)" />
            <stop offset="100%" stopColor="var(--blue-base)" />
          </linearGradient>
          <linearGradient id="dHighlight" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop
              offset="0%"
              stopColor="color-mix(in oklab, var(--shine) 92%, transparent)"
            />
            <stop offset="45%" stopColor="transparent" />
            <stop
              offset="80%"
              stopColor="color-mix(in oklab, var(--shine) 75%, transparent)"
            />
          </linearGradient>
          <linearGradient id="ribbon" x1="5%" y1="20%" x2="95%" y2="80%">
            <stop offset="0%" stopColor="var(--gold-base)" />
            <stop offset="50%" stopColor="var(--gold-warm)" />
            <stop
              offset="100%"
              stopColor="color-mix(in oklab, var(--gold-warm) 80%, #ffde7a 20%)"
            />
          </linearGradient>
          <linearGradient id="orbit" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop
              offset="0%"
              stopColor="color-mix(in oklab, var(--blue-light) 80%, white 10%)"
            />
            <stop offset="45%" stopColor="var(--gold-base)" />
            <stop
              offset="75%"
              stopColor="color-mix(in oklab, var(--blue-base) 75%, var(--gold-warm) 25%)"
            />
            <stop
              offset="100%"
              stopColor="color-mix(in oklab, var(--blue-light) 80%, white 10%)"
            />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="8" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="ringGlow">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g
          filter="url(#ringGlow)"
          className="animate-orbit-medium"
          opacity="0.7"
        >
          <path
            d="M44 190a140 96 0 1 0 232 0a140 96 0 1 0 -232 0z"
            fill="none"
            stroke="url(#orbit)"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <path
            d="M64 182a115 78 0 1 0 192 0a115 78 0 1 0 -192 0z"
            fill="none"
            stroke="url(#orbit)"
            strokeWidth="5"
            strokeLinecap="round"
            opacity="0.6"
          />
        </g>

        <g filter="url(#glow)" className="animate-soft-pulse" opacity="0.85">
          <path
            d="M86 216c50-10 102-12 150-10c18 0.7 32 6 42 16c5 5 5 13-1 17c-28 21-70 40-118 34c-32-4-57-18-80-32c-9-6-6-21 7-25Z"
            fill="url(#ribbon)"
            stroke="color-mix(in oklab, var(--gold-warm) 60%, transparent)"
            strokeWidth="1.2"
            opacity="0.9"
          />
        </g>

        <g filter="url(#glow)" className="animate-slow-float">
          <path
            d="M64 60c-8 0-14 6-14 14v182c0 8 6 14 14 14h82c79 0 124-36 124-100c0-62-46-110-120-110H64Z"
            fill="url(#dBody)"
            stroke="color-mix(in oklab, var(--blue-deep) 60%, transparent)"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path
            d="M104 104h90c44 0 70 24 70 66c0 44-28 70-88 70h-72Z"
            fill="url(#dHighlight)"
            opacity="0.85"
            transform="translate(-22 -5)"
          />
          <path
            d="M70 62c14-18 42-30 74-30h48c10 0 18 8 18 18s-8 18-18 18h-48c-20 0-45 6-68 18z"
            fill="color-mix(in oklab, var(--blue-light) 70%, #7dd5ff 20%)"
            opacity="0.85"
          />
        </g>
      </svg>
    </div>
  );
}
