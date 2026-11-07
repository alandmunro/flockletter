import { useId } from 'react';
import type { TemplateId, TemplateSummary } from '../shared/authoring.js';

export function TemplatePicker({
  templates,
  selected,
  onChange,
}: {
  templates: readonly TemplateSummary[];
  selected: TemplateId;
  onChange: (id: TemplateId) => void;
}) {
  const radioGroupName = useId();

  return (
    <fieldset>
      <legend>Choose a layout</legend>
      <div className="template-choices">
        {templates.map((template) => (
          <div key={template.id} className="template-choice">
            <label>
              <input
                type="radio"
                name={radioGroupName}
                value={template.id}
                checked={selected === template.id}
                onChange={() => onChange(template.id)}
                aria-describedby={radioGroupName + template.id}
              />
              <strong>{template.name}</strong>
            </label>
            <p id={radioGroupName + template.id}>{template.description}</p>
            <ol>
              {template.sections.map((section) => (
                <li key={section}>{section}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
