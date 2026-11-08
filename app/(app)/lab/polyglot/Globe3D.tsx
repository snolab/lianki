"use client";

import { useEffect, useRef } from "react";

type Language = {
  code: string;
  name: string;
  nativeName: string;
  lat?: number;
  lng?: number;
};

interface Globe3DProps {
  selectedLanguages: Language[];
  className?: string;
}

export default function Globe3D({ selectedLanguages, className = "" }: Globe3DProps) {
  const globeEl = useRef<HTMLDivElement>(null);
  const globeRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !globeEl.current) return;

    // Dynamically import globe.gl (only on client-side)
    import("globe.gl").then((GlobeGL) => {
      const Globe = GlobeGL.default;

      // Initialize globe
      const globe = new Globe(globeEl.current!)
        .globeImageUrl("//unpkg.com/three-globe/example/img/earth-blue-marble.jpg")
        .bumpImageUrl("//unpkg.com/three-globe/example/img/earth-topology.png")
        .backgroundColor("rgba(0,0,0,0)")
        .width(640)
        .height(640);

      // Set up camera angle
      globe.pointOfView({ altitude: 2.5 });

      // Enable auto-rotation
      const controls = globe.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.5;

      globeRef.current = globe;

      // Add language markers
      const languageCoordinates: { [key: string]: { lat: number; lng: number } } = {
        "en-US": { lat: 37.09, lng: -95.71 }, // USA
        "zh-CN": { lat: 35.86, lng: 104.19 }, // China
        "ja-JP": { lat: 36.2, lng: 138.25 }, // Japan
        "ko-KR": { lat: 35.9, lng: 127.76 }, // South Korea
        "es-ES": { lat: 40.46, lng: -3.74 }, // Spain
        "fr-FR": { lat: 46.22, lng: 2.21 }, // France
        "de-DE": { lat: 51.16, lng: 10.45 }, // Germany
        "it-IT": { lat: 41.87, lng: 12.56 }, // Italy
        "pt-BR": { lat: -14.23, lng: -51.92 }, // Brazil
        "ru-RU": { lat: 61.52, lng: 105.31 }, // Russia
        "ar-SA": { lat: 23.88, lng: 45.07 }, // Saudi Arabia
        "hi-IN": { lat: 20.59, lng: 78.96 }, // India
      };

      const markers = selectedLanguages
        .filter((lang) => languageCoordinates[lang.code])
        .map((lang) => ({
          lat: languageCoordinates[lang.code].lat,
          lng: languageCoordinates[lang.code].lng,
          size: 0.8,
          color: "#3b82f6",
          label: lang.nativeName,
        }));

      globe
        .pointsData(markers)
        .pointAltitude(0.01)
        .pointRadius("size")
        .pointColor("color")
        .pointLabel("label");
    });

    return () => {
      // Cleanup on unmount
      if (globeRef.current) {
        globeRef.current._destructor?.();
      }
    };
  }, [selectedLanguages]);

  return (
    <div className={`relative ${className}`}>
      <div ref={globeEl} className="mx-auto" />
    </div>
  );
}
