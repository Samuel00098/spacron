import React from 'react';

export interface ProjectIconDefinition {
  id: string;
  name: string;
  viewBox?: string;
  paths: React.ReactNode;
}

export const PROJECT_SVG_ICONS: ProjectIconDefinition[] = [
  {
    id: 'icon:folder',
    name: 'Folder',
    paths: (
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    ),
  },
  {
    id: 'icon:code',
    name: 'Code',
    paths: (
      <>
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </>
    ),
  },
  {
    id: 'icon:terminal',
    name: 'Terminal',
    paths: (
      <>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </>
    ),
  },
  {
    id: 'icon:bot',
    name: 'Bot',
    paths: (
      <>
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <line x1="8" y1="16" x2="8.01" y2="16" />
        <line x1="16" y1="16" x2="16.01" y2="16" />
      </>
    ),
  },
  {
    id: 'icon:package',
    name: 'Package',
    paths: (
      <>
        <path d="m16.5 9.4-9-5.16a2 2 0 0 0-2 0L2.5 6.08a2 2 0 0 0-1 1.74v8.36a2 2 0 0 0 1 1.74l3 1.74a2 2 0 0 0 2 0l9-5.16a2 2 0 0 0 1-1.74V9.4" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </>
    ),
  },
  {
    id: 'icon:database',
    name: 'Database',
    paths: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </>
    ),
  },
  {
    id: 'icon:globe',
    name: 'Globe',
    paths: (
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>
    ),
  },
  {
    id: 'icon:server',
    name: 'Server',
    paths: (
      <>
        <rect x="2" y="3" width="20" height="8" rx="2" ry="2" />
        <rect x="2" y="13" width="20" height="8" rx="2" ry="2" />
        <line x1="6" y1="7" x2="6.01" y2="7" />
        <line x1="6" y1="17" x2="6.01" y2="17" />
      </>
    ),
  },
  {
    id: 'icon:cpu',
    name: 'CPU',
    paths: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M15 2v2M9 2v2M20 15h2M20 9h2M9 20v2M15 20v2M2 9h2M2 15h2" />
      </>
    ),
  },
  {
    id: 'icon:layers',
    name: 'Layers',
    paths: (
      <>
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </>
    ),
  },
  {
    id: 'icon:braces',
    name: 'Braces',
    paths: (
      <>
        <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" />
        <path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
      </>
    ),
  },
  {
    id: 'icon:rocket',
    name: 'Rocket',
    paths: (
      <>
        <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
        <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      </>
    ),
  },
  {
    id: 'icon:wrench',
    name: 'Wrench',
    paths: (
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    ),
  },
  {
    id: 'icon:briefcase',
    name: 'Briefcase',
    paths: (
      <>
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      </>
    ),
  },
  {
    id: 'icon:building',
    name: 'Building',
    paths: (
      <>
        <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
        <path d="M9 22v-4h6v4" />
        <path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" />
      </>
    ),
  },
  {
    id: 'icon:palette',
    name: 'Palette',
    paths: (
      <>
        <circle cx="13.5" cy="6.5" r=".75" fill="currentColor" />
        <circle cx="17.5" cy="10.5" r=".75" fill="currentColor" />
        <circle cx="8.5" cy="7.5" r=".75" fill="currentColor" />
        <circle cx="6.5" cy="12.5" r=".75" fill="currentColor" />
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2z" />
      </>
    ),
  },
  {
    id: 'icon:gauge',
    name: 'Gauge',
    paths: (
      <>
        <path d="M12 2v2" />
        <path d="m4.93 4.93 1.41 1.41" />
        <path d="M20 12h2" />
        <path d="m19.07 4.93-1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M16.24 7.76a6 6 0 1 0-8.49 8.49" />
        <path d="m14 10-4 4" />
      </>
    ),
  },
  {
    id: 'icon:sparkles',
    name: 'Sparkles',
    paths: (
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    ),
  },
  {
    id: 'icon:shapes',
    name: 'Shapes',
    paths: (
      <>
        <path d="M8.3 10a.7.7 0 0 1-.626-.372L5.12 4.472A.7.7 0 0 1 5.746 3.5h5.108a.7.7 0 0 1 .626.972L8.926 9.628A.7.7 0 0 1 8.3 10Z" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <circle cx="17.5" cy="17.5" r="3.5" />
      </>
    ),
  },
  {
    id: 'icon:box3d',
    name: 'Cube',
    paths: (
      <>
        <path d="m21.12 6.4-6-3.5a2 2 0 0 0-2 0l-6 3.5A2 2 0 0 0 6.12 8.13v7.74a2 2 0 0 0 1 1.73l6 3.5a2 2 0 0 0 2 0l6-3.5a2 2 0 0 0 1-1.73V8.13a2 2 0 0 0-1-1.73Z" />
        <path d="m12 22 9.12-5.27" />
        <path d="m12 12 9.12-5.27" />
        <path d="m12 12-9.12-5.27" />
        <path d="M12 12v10" />
      </>
    ),
  },
];

export const PROJECT_EMOJIS = [
  '🚀', '⚡', '📦', '💻', '🌐', '🛠️', '🎯', '🎨',
  '🧪', '📱', '🤖', '🔥', '🦀', '🐍', '▲', '🧡',
  '💡', '💎', '⭐', '☕', '🧠', '🧩', '🔒', '📊',
];

export function isProjectSvgIcon(icon: string | null | undefined): boolean {
  return typeof icon === 'string' && icon.startsWith('icon:');
}

export function ProjectSvgIcon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const match = PROJECT_SVG_ICONS.find((i) => i.id === name) || PROJECT_SVG_ICONS[0];
  return (
    <svg
      width={size}
      height={size}
      viewBox={match.viewBox || '0 0 24 24'}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {match.paths}
    </svg>
  );
}

export function ProjectIconBadge({
  icon,
  size = 18,
  className = '',
}: {
  icon: string | null | undefined;
  size?: number;
  className?: string;
}) {
  if (isProjectSvgIcon(icon)) {
    return <ProjectSvgIcon name={icon!} size={size} className={className} />;
  }
  if (icon && (icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:image/') || icon.startsWith('asset://') || icon.endsWith('.png') || icon.endsWith('.jpg') || icon.endsWith('.svg') || icon.endsWith('.webp'))) {
    return (
      <img
        src={icon}
        alt=""
        style={{ width: `${size}px`, height: `${size}px`, objectFit: 'contain', borderRadius: '3px' }}
        className={className}
      />
    );
  }
  if (!icon || icon === '📁' || icon === 'icon:folder') {
    return <ProjectSvgIcon name="icon:folder" size={size} className={className} />;
  }
  return <span style={{ fontSize: `${Math.round(size * 0.85)}px`, lineHeight: 1 }} className={className}>{icon}</span>;
}
