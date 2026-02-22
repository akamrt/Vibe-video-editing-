import React from 'react';
import { AbsoluteFill } from 'remotion';
import AnimatedTitle from './AnimatedTitle';
import GlobalSubtitleOverlay from './GlobalSubtitleOverlay';
import type { Segment, AnalysisEvent, SubtitleStyle, TitleStyle, TitleLayer, SubtitleTemplate, AnimationPreset, TextAnimation } from '../../types';

export interface RemotionVideoProps {
  segments: Segment[];
  events: AnalysisEvent[];
  subtitleStyle: SubtitleStyle;
  titleStyle: TitleStyle;
  titleLayer: TitleLayer | null;
  activeSubtitleTemplate: SubtitleTemplate | null;
  activeTitleTemplate: SubtitleTemplate | null;
  activeKeywordAnimation?: TextAnimation | null;
  fps: number;
}

// Default legacy animation converted to new format
const DEFAULT_TITLE_ANIMATION: TextAnimation = {
  id: 'default',
  name: 'Default',
  duration: 1,
  scope: 'element',
  stagger: 0,
  effects: [{ id: 'def_1', type: 'scale', from: 0.3, to: 1, startAt: 0, endAt: 1, easing: 'spring' }]
};

const RemotionVideo: React.FC<RemotionVideoProps> = ({
  segments,
  events,
  subtitleStyle,
  titleStyle,
  titleLayer,
  activeSubtitleTemplate,
  activeTitleTemplate,
  activeKeywordAnimation,
  fps,
}) => {
  // Map segments to frame-based data for the subtitle overlay
  const segmentFrameData = segments.map(seg => ({
    sourceOffset: seg.startTime,
    timelineStartFrame: Math.round(seg.timelineStart * fps),
    durationFrames: Math.round((seg.endTime - seg.startTime) * fps),
  }));

  const titleAnimation = titleLayer?.animation ?? activeTitleTemplate?.animation ?? DEFAULT_TITLE_ANIMATION;

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Subtitle Overlay */}
      <GlobalSubtitleOverlay
        events={events}
        subtitleStyle={subtitleStyle}
        template={activeSubtitleTemplate}
        activeKeywordAnimation={activeKeywordAnimation}
        segments={segmentFrameData}
      />

      {/* Title Overlay */}
      {titleLayer && (
        <AnimatedTitle
          titleLayer={titleLayer}
          titleStyle={titleLayer.style || titleStyle}
          animation={titleAnimation}
        />
      )}
    </AbsoluteFill>
  );
};

export default RemotionVideo;
