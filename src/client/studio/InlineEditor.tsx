import { useEffect, useRef, useState } from 'react';
import { Editor, Node } from '@tiptap/core';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { Bold, HardBreak, Italic, Link, Paragraph, Text } from '@react-email/editor/extensions';
import { validateStudioLink, type StudioRun } from '../../shared/studio.js';
import { inlineDocument, inlineRuns } from './inline-document.js';

// The surrounding canvas owns layout. This editor may change inline text in exactly one block.
const singleParagraph = Node.create({ name: 'doc', topNode: true, content: 'paragraph' });
const extensions = [
  singleParagraph,
  Paragraph,
  Text,
  HardBreak,
  Bold,
  Italic,
  UndoRedo,
  Link.configure({
    openOnClick: false,
    autolink: false,
    linkOnPaste: false,
    isAllowedUri: validateStudioLink,
  }),
];
type Props = {
  runs: StudioRun[];
  label: string;
  disabled: boolean;
  onRuns: (next: StudioRun[]) => boolean;
  onIssue: (message: string) => void;
};
type LinkSelection = {
  from: number;
  to: number;
  originalText: string;
  text: string;
  href: string;
  wasLinked: boolean;
};

export function InlineEditor(props: Props) {
  const node = useRef<HTMLDivElement>(null);
  const editing = useRef<Editor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const accepted = useRef(JSON.stringify(props.runs));
  const [format, setFormat] = useState({ bold: false, italic: false, link: false });
  const [link, setLink] = useState<LinkSelection | null>(null);
  const [notice, setNotice] = useState('');
  const [linkError, setLinkError] = useState('');

  useEffect(() => {
    if (!node.current) return;
    const snapshot = latest.current;
    accepted.current = JSON.stringify(snapshot.runs);
    const handleSelection = (editor: Editor) =>
      setFormat({
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        link: editor.isActive('link'),
      });
    const editor = new Editor({
      element: node.current,
      extensions,
      content: inlineDocument(snapshot.runs),
      editable: !snapshot.disabled,
      enableContentCheck: true,
      enableInputRules: false,
      enablePasteRules: false,
      injectCSS: false,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': snapshot.label,
          'aria-multiline': 'true',
          spellcheck: 'true',
        },
        handleKeyDown(_view, event) {
          if (event.key !== 'Enter' || event.isComposing || !editing.current?.isEditable) return false;
          event.preventDefault();
          return editing.current.commands.setHardBreak();
        },
        // Intercept the native event before ProseMirror parses clipboard HTML or embedded images.
        handleDOMEvents: {
          paste(_view, event) {
            event.preventDefault();
            const current = editing.current;
            if (!current?.isEditable) return true;
            const clipboard = event.clipboardData;
            const copied = clipboard?.getData('text/plain') ?? '';
            if (!copied || clipboard?.files.length || copied.length > 24000) {
              latest.current.onIssue(
                'Paste up to 24,000 characters of plain text. Add photos from the brand image library.',
              );
              return true;
            }
            const content =
              inlineDocument([{ text: copied.replace(/\r\n?/g, '\n') }]).content![0]!.content ?? [];
            current.commands.insertContent(content);
            setNotice('Pasted as plain text.');
            return true;
          },
          drop(_view, event) {
            event.preventDefault();
            latest.current.onIssue('Use the block controls to move content or choose a brand image.');
            return true;
          },
        },
      },
      onContentError() {
        latest.current.onIssue(
          'This text block cannot be opened safely. Restore the last valid text to continue.',
        );
      },
      onUpdate({ editor }) {
        try {
          const runs = inlineRuns(editor.getJSON());
          if (latest.current.onRuns(runs)) accepted.current = JSON.stringify(runs);
        } catch (error) {
          latest.current.onIssue(
            error instanceof Error ? error.message : 'Restore the last valid text to continue.',
          );
        }
      },
      onSelectionUpdate: ({ editor }) => handleSelection(editor),
      onTransaction: ({ editor }) => handleSelection(editor),
    });
    editing.current = editor;
    return () => {
      editing.current = null;
      editor.destroy();
    };
  }, []);

  useEffect(() => {
    const current = editing.current,
      signature = JSON.stringify(props.runs);
    if (current && accepted.current !== signature) {
      current.commands.setContent(inlineDocument(props.runs), {
        emitUpdate: false,
        errorOnInvalidContent: true,
      });
      accepted.current = signature;
    }
  }, [props.runs]);
  useEffect(() => {
    editing.current?.setEditable(!props.disabled && !link, false);
  }, [props.disabled, link]);

  function openLink() {
    const editor = editing.current;
    if (!editor || props.disabled) return;
    if (editor.isActive('link')) editor.chain().focus().extendMarkRange('link').run();
    const { from, to } = editor.state.selection;
    const originalText = editor.state.doc.textBetween(from, to, '\n');
    const href = editor.getAttributes('link').href;
    setLink({
      from,
      to,
      originalText,
      text: originalText,
      href: typeof href === 'string' ? href : '',
      wasLinked: editor.isActive('link'),
    });
    setLinkError('');
    setNotice('');
    props.onIssue('Apply or cancel the link edit before saving.');
  }
  function closeLink() {
    setLink(null);
    setLinkError('');
    props.onIssue('');
    const editor = editing.current;
    if (editor && !props.disabled) {
      editor.setEditable(true, false);
      editor.commands.focus();
    }
  }
  function applyLink(remove = false) {
    const editor = editing.current;
    if (!editor || !link || props.disabled) return;
    if (!remove && (!link.text.trim() || !validateStudioLink(link.href) || link.href.length > 2048)) {
      setLinkError('Enter link text and a public HTTPS address.');
      return;
    }
    editor.setEditable(true, false);
    const chain = editor.chain().focus().setTextSelection({ from: link.from, to: link.to });
    if (remove) chain.unsetLink().run();
    else if (link.text === link.originalText) chain.setLink({ href: link.href }).run();
    else {
      const marks = [...editor.state.doc.resolve(link.from).marks()]
        .filter((m) => m.type.name === 'bold' || m.type.name === 'italic')
        .map((m) => ({ type: m.type.name }));
      chain
        .insertContent({
          type: 'text',
          text: link.text,
          marks: [...marks, { type: 'link', attrs: { href: link.href } }],
        })
        .run();
    }
    // A no-op apply can legitimately emit no editor transaction. Resolve the pending form in that case too.
    try {
      const runs = inlineRuns(editor.getJSON());
      if (JSON.stringify(runs) === accepted.current) props.onIssue('');
      else if (props.onRuns(runs)) accepted.current = JSON.stringify(runs);
    } catch (error) {
      props.onIssue(error instanceof Error ? error.message : 'Restore the last valid text to continue.');
    }
    setLink(null);
    setLinkError('');
  }

  return (
    <div className="studio-inline">
      <div className="studio-format" role="group" aria-label="Text formatting">
        <button
          type="button"
          aria-label="Bold"
          aria-pressed={format.bold}
          disabled={props.disabled || !!link}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editing.current?.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          aria-label="Italic"
          aria-pressed={format.italic}
          disabled={props.disabled || !!link}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editing.current?.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </button>
        <button
          type="button"
          aria-label="Link"
          aria-pressed={format.link}
          disabled={props.disabled || !!link}
          onMouseDown={(e) => e.preventDefault()}
          onClick={openLink}
        >
          Link
        </button>
      </div>
      {link && (
        <fieldset className="studio-link-form" disabled={props.disabled}>
          <legend>Edit link</legend>
          <label>
            Link text
            <input
              type="text"
              maxLength={12000}
              value={link.text}
              autoFocus
              onChange={(e) => setLink({ ...link, text: e.target.value })}
            />
          </label>
          <label>
            Link address
            <input
              type="url"
              maxLength={2048}
              value={link.href}
              onChange={(e) => setLink({ ...link, href: e.target.value })}
            />
          </label>
          {linkError && (
            <p role="alert" className="studio-error">
              {linkError}
            </p>
          )}
          <div className="studio-actions">
            <button type="button" className="btn" onClick={() => applyLink()}>
              Apply link
            </button>
            {link.wasLinked && (
              <button type="button" className="btn secondary" onClick={() => applyLink(true)}>
                Remove link
              </button>
            )}
            <button type="button" className="btn secondary" onClick={closeLink}>
              Cancel link
            </button>
          </div>
        </fieldset>
      )}
      <div ref={node} className="studio-rich-surface" />
      {notice && (
        <p role="status" className="studio-note">
          {notice}
        </p>
      )}
    </div>
  );
}
