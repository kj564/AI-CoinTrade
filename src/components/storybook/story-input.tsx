"use client";

import { useState } from "react";
import { Sparkles, Loader2, Wand2, BookOpen, Lightbulb, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStorybook } from "@/lib/storybook/store";
import { VOICE_OPTIONS, type Resolution, type VoiceId } from "@/lib/storybook/types";
import { toast } from "sonner";

const TOPIC_PRESETS = [
  { icon: BookOpen, label: "The little seed that grew", value: "A tiny seed in a child's garden learns patience as it grows into a sunflower with the help of sun, rain and a friendly worm." },
  { icon: Lightbulb, label: "How bees help flowers", value: "A friendly bee named Bella teaches a curious flower why bees and flowers need each other, in gentle paper-cutout scenes." },
  { icon: Megaphone, label: "Our cozy bakery brand", value: "A warm brand story for a small neighborhood bakery: every morning, flour, butter and love become the bread that brings the street together." },
];

export function StoryInput({ onPlan }: { onPlan: (data: { title: string; scenes: import("@/lib/storybook/types").Scene[] }) => void }) {
  const topic = useStorybook((s) => s.topic);
  const script = useStorybook((s) => s.script);
  const sceneCount = useStorybook((s) => s.sceneCount);
  const resolution = useStorybook((s) => s.resolution);
  const voice = useStorybook((s) => s.voice);
  const music = useStorybook((s) => s.music);
  const setTopic = useStorybook((s) => s.setTopic);
  const setScript = useStorybook((s) => s.setScript);
  const setSceneCount = useStorybook((s) => s.setSceneCount);
  const setResolution = useStorybook((s) => s.setResolution);
  const setVoice = useStorybook((s) => s.setVoice);
  const setMusic = useStorybook((s) => s.setMusic);
  const setPhase = useStorybook((s) => s.setPhase);
  const setError = useStorybook((s) => s.setError);

  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!topic.trim()) {
      toast.error("Give your storybook a topic first.");
      return;
    }
    setBusy(true);
    setPhase("planning");
    setError(null);
    try {
      const res = await fetch("/api/plan-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, script, sceneCount }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: "Planning failed." }));
        throw new Error(j.error ?? "Planning failed.");
      }
      const data = await res.json();
      onPlan(data);
      toast.success(`"${data.title}" planned with ${data.scenes.length} scenes!`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Planning failed.";
      setError(msg);
      setPhase("input");
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="rounded-2xl border-2 border-[#c98b5a]/30 bg-[#fff8e7] p-5 sm:p-7 shadow-[0_18px_44px_-20px_rgba(120,70,20,0.45)]">
        <div className="flex flex-col gap-5">
          {/* Topic */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="topic" className="text-sm font-bold text-[#4a3517]">
              Your story, lesson or brand message
            </Label>
            <Textarea
              id="topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. A tiny seed learns patience as it grows into a sunflower with help from sun, rain and a friendly worm."
              rows={3}
              className="resize-none border-[#c98b5a]/40 bg-white/60 text-[#3a2a16] placeholder:text-[#9a7a55]"
            />
            <div className="flex flex-wrap gap-2">
              {TOPIC_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setTopic(p.value)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#c98b5a]/40 bg-[#fde9c8] px-2.5 py-1 text-xs text-[#7a4a1e] hover:bg-[#f4d9b0] transition-colors"
                >
                  <p.icon className="h-3 w-3" /> {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Optional script */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="script" className="text-sm font-bold text-[#4a3517]">
              Script or notes <span className="font-normal text-[#9a7a55]">(optional)</span>
            </Label>
            <Textarea
              id="script"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Paste a script, bullet points or notes. The director will shape them into scenes."
              rows={4}
              className="resize-none border-[#c98b5a]/40 bg-white/60 text-[#3a2a16] placeholder:text-[#9a7a55]"
            />
          </div>

          {/* Options grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-bold text-[#4a3517]">Scenes</Label>
              <div className="flex items-center gap-3">
                <Slider
                  value={[sceneCount]}
                  min={2}
                  max={8}
                  step={1}
                  onValueChange={(v) => setSceneCount(v[0])}
                  className="flex-1"
                />
                <span className="w-8 text-center font-mono text-sm font-bold text-[#c7634a]">{sceneCount}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-sm font-bold text-[#4a3517]">Narrator voice</Label>
              <Select value={voice} onValueChange={(v) => setVoice(v as VoiceId)}>
                <SelectTrigger className="border-[#c98b5a]/40 bg-white/60 text-[#3a2a16]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICE_OPTIONS.map((v) => (
                    <SelectItem key={v.value} value={v.value}>
                      <span className="font-medium">{v.label}</span>
                      <span className="text-xs text-muted-foreground ml-2">{v.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-sm font-bold text-[#4a3517]">Export resolution</Label>
              <Select value={resolution} onValueChange={(v) => setResolution(v as Resolution)}>
                <SelectTrigger className="border-[#c98b5a]/40 bg-white/60 text-[#3a2a16]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1080p">1080p · Full HD</SelectItem>
                  <SelectItem value="2K">2K · QHD</SelectItem>
                  <SelectItem value="4K">4K · Ultra HD</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-sm font-bold text-[#4a3517]">Music bed</Label>
              <div className="flex items-center gap-2 h-9">
                <Switch checked={music} onCheckedChange={setMusic} />
                <span className="text-sm text-[#7a5a3a]">{music ? "Warm ambient pad on" : "No music"}</span>
              </div>
            </div>
          </div>

          {/* CTA */}
          <Button
            onClick={submit}
            disabled={busy || !topic.trim()}
            size="lg"
            className="mt-1 w-full bg-[#c7634a] hover:bg-[#b15438] text-white font-bold rounded-xl h-12 text-base shadow-[0_10px_24px_-10px_rgba(199,99,74,0.7)]"
          >
            {busy ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" /> Planning your storybook…
              </>
            ) : (
              <>
                <Wand2 className="h-5 w-5" /> Plan my storybook
              </>
            )}
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-center text-xs text-[#9a7a55]">
            <Sparkles className="h-3.5 w-3.5" />
            The director writes scenes, builds props around your subject, then cuts the illustrations.
          </p>
        </div>
      </div>
    </div>
  );
}
