import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';

export interface AgentTemplate {
  id: string;
  version: string;
  name: string;
  description: string;
}

export function useAgentTemplates() {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [templateError, setTemplateError] = useState('');

  useEffect(() => {
    let active = true;
    api<{ templates: AgentTemplate[] }>('/onboard/templates')
      .then((result) => {
        if (!active) return;
        setTemplates(result.templates);
        setTemplateError('');
      })
      .catch((cause) => { if (active) setTemplateError(errMsg(cause)); });
    return () => { active = false; };
  }, []);

  return { templates, templateError };
}
