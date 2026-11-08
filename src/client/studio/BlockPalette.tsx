export type PaletteKind = 'paragraph' | 'heading' | 'image' | 'button' | 'divider' | 'spacer' | 'columns';

type BlockPaletteProps = {
  onAdd: (kind: PaletteKind) => void;
  disabled: boolean;
  allowColumns: boolean;
  hasImages: boolean;
  atImageLimit: boolean;
};

export function BlockPalette({ onAdd, disabled, allowColumns, hasImages, atImageLimit }: BlockPaletteProps) {
  const imageDisabled = disabled || !hasImages || atImageLimit;
  const imageTitle = atImageLimit
    ? 'All six image placements are in use.'
    : hasImages
      ? undefined
      : 'Add a brand image in the image library first.';

  return (
    <div className="studio-palette" role="group" aria-label="Add a block">
      <button
        type="button"
        className="studio-palette-button"
        disabled={disabled}
        onClick={() => onAdd('paragraph')}
        aria-label="Add paragraph"
      >
        Paragraph
      </button>

      <button
        type="button"
        className="studio-palette-button"
        disabled={disabled}
        onClick={() => onAdd('heading')}
        aria-label="Add heading"
      >
        Heading
      </button>

      <button
        type="button"
        className="studio-palette-button"
        disabled={imageDisabled}
        onClick={() => onAdd('image')}
        aria-label="Add image"
        title={imageTitle}
      >
        Image
      </button>

      <button
        type="button"
        className="studio-palette-button"
        disabled={disabled}
        onClick={() => onAdd('button')}
        aria-label="Add button"
      >
        Button
      </button>

      <button
        type="button"
        className="studio-palette-button"
        disabled={disabled}
        onClick={() => onAdd('divider')}
        aria-label="Add divider"
      >
        Divider
      </button>

      <button
        type="button"
        className="studio-palette-button"
        disabled={disabled}
        onClick={() => onAdd('spacer')}
        aria-label="Add spacer"
      >
        Spacer
      </button>

      {allowColumns && (
        <button
          type="button"
          className="studio-palette-button"
          disabled={disabled}
          onClick={() => onAdd('columns')}
          aria-label="Add two columns"
        >
          Two columns
        </button>
      )}
    </div>
  );
}
