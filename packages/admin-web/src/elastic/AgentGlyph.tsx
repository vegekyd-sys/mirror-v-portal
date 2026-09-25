export default function AgentGlyph({ templateId }: { templateId: string }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {templateId === 'mirror-v' ? <><circle cx="12" cy="12" r="8.5" /><ellipse cx="12" cy="12" rx="4" ry="8.5" /><path d="M3.5 12h17" /></> :
      templateId === 'dealclaw' ? <><path d="m12 2 7.5 10-7.5 10L4.5 12 12 2Z" /><path d="m12 7 3.5 5-3.5 5-3.5-5L12 7Z" /></> :
      <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3" /></>}
  </svg>;
}
