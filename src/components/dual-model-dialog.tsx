import { useMemo } from "react";
import { CheckIcon, GitForkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { ModelInfo } from "@/lib/pi";
import type { DualModelConfig, ModelRef } from "@/hooks/useDualModel";

function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const map = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const list = map.get(model.provider) ?? [];
    list.push(model);
    map.set(model.provider, list);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function ModelList({
  models,
  selected,
  onSelect,
  heading,
}: {
  models: ModelInfo[];
  selected: ModelRef | null;
  onSelect: (model: ModelInfo) => void;
  heading: string;
}) {
  const groups = useMemo(() => groupByProvider(models), [models]);
  return (
    <div className="overflow-hidden rounded-md border">
      <p className="border-b bg-muted/40 px-2 py-1 text-[10px] font-medium text-muted-foreground">
        {heading}
      </p>
      <Command className="rounded-none">
        <CommandInput placeholder="搜索模型…" />
        <CommandList className="max-h-40">
          <CommandEmpty>没有匹配的模型</CommandEmpty>
          {groups.map(([provider, list]) => (
            <CommandGroup heading={provider} key={provider}>
              {list.map((model) => (
                <CommandItem
                  key={`${model.provider}/${model.id}`}
                  onSelect={() => onSelect(model)}
                  value={`${model.provider} ${model.name} ${model.id}`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{model.name}</span>
                  {model.reasoning ? (
                    <Badge className="text-[10px]" variant="outline">
                      reasoning
                    </Badge>
                  ) : null}
                  {selected?.provider === model.provider && selected?.id === model.id ? (
                    <CheckIcon className="size-3.5 shrink-0" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}

/** Dual-model setup: planner writes the plan, executor carries it out. */
export function DualModelDialog({
  open,
  onOpenChange,
  config,
  models,
  setEnabled,
  setPlanner,
  setExecutor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: DualModelConfig;
  models: ModelInfo[];
  setEnabled: (enabled: boolean) => void;
  setPlanner: (ref: ModelRef | null) => void;
  setExecutor: (ref: ModelRef | null) => void;
}) {
  const toRef = (model: ModelInfo): ModelRef => ({ provider: model.provider, id: model.id });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <GitForkIcon className="size-4" />
            双模型：规划 + 执行
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs">启用双模型</p>
            <p className="text-[11px] text-muted-foreground">
              规划模型只出方案；完成后自动切换执行模型继续
            </p>
          </div>
          <Switch checked={config.enabled} onCheckedChange={setEnabled} />
        </div>

        <ModelList
          heading="规划模型（只读分析，不改文件）"
          models={models}
          onSelect={(model) => setPlanner(toRef(model))}
          selected={config.planner}
        />
        <ModelList
          heading="执行模型（按方案实施）"
          models={models}
          onSelect={(model) => setExecutor(toRef(model))}
          selected={config.executor}
        />

        <p className="text-[11px] text-muted-foreground">
          执行结束会恢复你当前选择的模型。规划中随时可点停止，链条会中止。
        </p>
      </DialogContent>
    </Dialog>
  );
}
