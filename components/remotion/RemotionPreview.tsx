import React from 'react';
import { Player } from '@remotion/player';
import RemotionVideo from './RemotionVideo';
import type { RemotionVideoProps } from './RemotionVideo';
import { REMOTION_FPS } from '../../types';

interface RemotionPreviewProps {
  width: number;
  height: number;
  durationInSeconds: number;
  compositionWidth?: number;
  compositionHeight?: number;
  videoProps: RemotionVideoProps;
}

const RemotionPreview: React.FC<RemotionPreviewProps> = ({
  width,
  height,
  durationInSeconds,
  compositionWidth = 1080,
  compositionHeight = 1920,
  videoProps,
}) => {
  const fps = videoProps.fps || REMOTION_FPS;
  const durationInFrames = Math.max(1, Math.round(durationInSeconds * fps));

  return (
    <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
      <Player
        component={RemotionVideo}
        inputProps={videoProps}
        durationInFrames={durationInFrames}
        compositionWidth={compositionWidth}
        compositionHeight={compositionHeight}
        fps={fps}
        style={{
          width: '100%',
          height: '100%',
        }}
        controls
        autoPlay={false}
        loop
      />
    </div>
  );
};

export default RemotionPreview;
