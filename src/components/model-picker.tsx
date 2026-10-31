import { useState } from "react";
import { CheckIcon, ChevronDownIcon, ZapIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ModelInfo } from "@/lib/pi";

function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const map = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = map.get(m.provider) ?? [];
    list.push(m);
    map.set(m.provider, list);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** ZCode-style model selector: anchored popover above the composer, not a modal. */
export function ModelPicker({
  model,
  models,
  onSelect,
}: {
  model?: ModelInfo;
  models: ModelInfo[];
  onSelect: (model: ModelInfo) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          title="选择模型"
          variant="ghost"
        >
          <ZapIcon className="size-3" />
          <span className="max-w-40 truncate">{model?.name ?? "选择模型"}</span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0" side="top">
        <Command>
          <CommandInput placeholder="搜索模型…" />
          <CommandList className="max-h-72">
            <CommandEmpty>没有匹配的模型</CommandEmpty>
            {groupByProvider(models).map(([provider, list]) => (
              <CommandGroup heading={provider} key={provider}>
                {list.map((m) => (
                  <CommandItem
                    key={`${m.provider}/${m.id}`}
                    onSelect={() => {
                      onSelect(m);
                      setOpen(false);
                    }}
                    value={`${m.provider} ${m.name} ${m.id}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">{m.name}</span>
                    {m.reasoning ? (
                      <Badge className="text-[10px]" variant="outline">
                        reasoning
                      </Badge>
                    ) : null}
                    {model && model.provider === m.provider && model.id === m.id ? (
                      <CheckIcon className="size-3.5 shrink-0" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
