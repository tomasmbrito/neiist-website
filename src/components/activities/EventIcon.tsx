"use client";
import { useEffect, useState, type CSSProperties } from "react";
import type { IconType } from "react-icons";
import {
  DEFAULT_EVENT_ICON,
  ICON_REGISTRY,
  loadLegacyEventIcon,
} from "@/components/activities/IconRegistry";

interface EventIconProps {
  name?: string | null;
  size?: number;
  style?: CSSProperties;
}

export default function EventIcon({ name, size, style }: EventIconProps) {
  const registeredIcon = name ? ICON_REGISTRY[name] : undefined;
  const [legacyIcon, setLegacyIcon] = useState<IconType | null>(null);

  useEffect(() => {
    if (!name || registeredIcon) {
      setLegacyIcon(null);
      return;
    }

    let isCurrent = true;
    loadLegacyEventIcon(name).then((icon) => {
      if (isCurrent) setLegacyIcon(() => icon);
    });

    return () => {
      isCurrent = false;
    };
  }, [name, registeredIcon]);

  const Icon = registeredIcon ?? legacyIcon ?? DEFAULT_EVENT_ICON;
  return <Icon size={size} style={style} />;
}
