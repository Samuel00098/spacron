import { AgentBrandMark } from '$lib/components/shared/useAgentBrand.tsx';

/**
 * An agent's mark in a fixed 16px box. The brand SVGs have no size of their own
 * (`.agent-brand-mark` fills whatever contains it), so every host sets one.
 */
export default function HistoryBrand({ command, name }: { command: string; name: string }) {
  return (
    <span className="ah-brand">
      <AgentBrandMark command={command} name={name} />
    </span>
  );
}
