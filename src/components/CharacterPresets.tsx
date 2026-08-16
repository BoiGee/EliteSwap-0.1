import { memo, useState } from "react";

interface CharacterPreset {
  id: string;
  name: string;
  prompt: string;
  emoji: string;
}

// Emoji here are the actual content (the visual identifier for each preset),
// not decoration — kept deliberately, unlike the decorative emoji removed
// elsewhere in the redesign.
const PRESETS: CharacterPreset[] = [
  { id: "superhero", name: "Superhero", prompt: "Transform the person into a superhero with a cape and mask, comic book style", emoji: "🦸" },
  { id: "anime", name: "Anime", prompt: "Transform the person into an anime character with large expressive eyes, anime art style", emoji: "🎌" },
  { id: "zombie", name: "Zombie", prompt: "Transform the person into a zombie with pale green skin, dark eye circles, and torn clothing", emoji: "🧟" },
  { id: "robot", name: "Cyborg", prompt: "Transform the person into a cyborg with metallic skin, glowing eyes, and mechanical parts", emoji: "🤖" },
  { id: "vampire", name: "Vampire", prompt: "Transform the person into an elegant vampire with pale skin, red eyes, and fangs", emoji: "🧛" },
  { id: "elf", name: "Elf", prompt: "Transform the person into a fantasy elf with pointed ears, ethereal glow, and elegant features", emoji: "🧝" },
  { id: "pirate", name: "Pirate", prompt: "Transform the person into a pirate captain with an eyepatch, tricorn hat, and weathered face", emoji: "🏴‍☠️" },
  { id: "alien", name: "Alien", prompt: "Transform the person into an alien with blue-grey skin, large dark eyes, and an elongated head", emoji: "👽" },
];

interface Props {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}

function CharacterPresetsImpl({ onSelect, disabled }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-4 gap-2">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          disabled={disabled}
          onClick={() => {
            setSelected(preset.id);
            onSelect(preset.prompt);
          }}
          className={`
            relative group flex flex-col items-center gap-1.5 p-3 rounded-lg
            border transition-all duration-300 cursor-pointer
            ${selected === preset.id
              ? "border-primary bg-primary/10 ring-1 ring-primary/40"
              : "border-border hover:border-primary/30 bg-muted/30 hover:bg-muted/50"
            }
            disabled:opacity-40 disabled:cursor-not-allowed
          `}
        >
          <span className="text-2xl">{preset.emoji}</span>
          <span className="text-xs font-heading font-medium text-foreground/80">{preset.name}</span>
          {selected === preset.id && (
            <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-primary animate-pulse-neon" />
          )}
        </button>
      ))}
    </div>
  );
}

export const CharacterPresets = memo(CharacterPresetsImpl);

