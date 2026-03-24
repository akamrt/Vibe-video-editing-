import React, { useState, useEffect } from 'react';
import { RenderJob } from '../types';
import { renderQueue } from '../services/renderQueue';

const formatEta = (seconds: number | null): string => {
  if (seconds === null || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

const getStatusColor = (status: RenderJob['status']): string => {
  switch (status) {
    case 'queued': return '#888';
    case 'rendering': return '#3b82f6';
    case 'done': return '#22c55e';
    case 'error': return '#ef4444';
    case 'aborted': return '#f59e0b';
  }
};

const getStatusLabel = (status: RenderJob['status']): string => {
  switch (status) {
    case 'queued': return 'Queued';
    case 'rendering': return 'Rendering';
    case 'done': return 'Complete';
    case 'error': return 'Failed';
    case 'aborted': return 'Aborted';
  }
};

const RenderQueuePanel: React.FC = () => {
  const [jobs, setJobs] = useState<RenderJob[]>([]);

  useEffect(() => {
    return renderQueue.subscribe(setJobs);
  }, []);

  const hasFinished = jobs.some(j => j.status === 'done' || j.status === 'error' || j.status === 'aborted');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid #333',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: 1 }}>
          Render Queue
        </span>
        {hasFinished && (
          <button
            onClick={() => renderQueue.clearFinished()}
            style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 4,
              background: '#333', border: 'none', color: '#999',
              cursor: 'pointer',
            }}
          >
            Clear Finished
          </button>
        )}
      </div>

      {/* Job List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {jobs.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', color: '#666',
            fontSize: 12, padding: 16, textAlign: 'center',
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🎬</div>
            <div>No renders in queue</div>
            <div style={{ marginTop: 4, color: '#555', fontSize: 11 }}>Use Export to add renders</div>
          </div>
        ) : (
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {jobs.map(job => (
              <div key={job.id} style={{
                background: '#1a1a1a', border: '1px solid #333',
                borderRadius: 8, padding: 12,
              }}>
                {/* Job header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{
                    fontSize: 12, fontWeight: 500, color: '#e0e0e0',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    flex: 1, marginRight: 8,
                  }}>
                    {job.name}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    color: getStatusColor(job.status),
                    backgroundColor: `${getStatusColor(job.status)}15`,
                  }}>
                    {getStatusLabel(job.status)}
                  </span>
                </div>

                {/* Progress bar */}
                {(job.status === 'rendering' || job.status === 'queued') && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{
                      height: 6, background: '#333', borderRadius: 3, overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%', borderRadius: 3,
                        width: `${Math.round(job.progress * 100)}%`,
                        backgroundColor: getStatusColor(job.status),
                        transition: 'width 0.3s ease',
                      }} />
                    </div>
                  </div>
                )}

                {/* Stats row */}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  fontSize: 10, color: '#888',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {job.status === 'rendering' && (
                      <>
                        <span>{Math.round(job.progress * 100)}%</span>
                        <span>Frame {job.currentFrame}/{job.totalFrames}</span>
                        <span>ETA: {formatEta(job.eta)}</span>
                      </>
                    )}
                    {job.status === 'done' && (
                      <span style={{ color: '#22c55e' }}>Ready to download</span>
                    )}
                    {job.status === 'error' && (
                      <span style={{ color: '#ef4444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }} title={job.error || ''}>
                        {job.error}
                      </span>
                    )}
                    {job.status === 'queued' && (
                      <span>Waiting...</span>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {job.status === 'rendering' && (
                      <button
                        onClick={() => renderQueue.abortJob(job.id)}
                        style={{
                          padding: '2px 6px', borderRadius: 4, fontSize: 10, border: 'none',
                          background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', cursor: 'pointer',
                        }}
                      >
                        Abort
                      </button>
                    )}
                    {job.status === 'queued' && (
                      <button
                        onClick={() => renderQueue.abortJob(job.id)}
                        style={{
                          padding: '2px 6px', borderRadius: 4, fontSize: 10, border: 'none',
                          background: '#333', color: '#999', cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    )}
                    {job.status === 'done' && (
                      <button
                        onClick={() => renderQueue.downloadJob(job.id)}
                        style={{
                          padding: '2px 6px', borderRadius: 4, fontSize: 10, border: 'none',
                          background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e', cursor: 'pointer',
                        }}
                      >
                        Download
                      </button>
                    )}
                    {(job.status === 'done' || job.status === 'error' || job.status === 'aborted') && (
                      <button
                        onClick={() => renderQueue.removeJob(job.id)}
                        style={{
                          padding: '2px 6px', borderRadius: 4, fontSize: 10, border: 'none',
                          background: '#333', color: '#999', cursor: 'pointer',
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RenderQueuePanel;
