import React, { useRef } from 'react';

export const CookieUploadButton: React.FC = () => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleCookieUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();

            let res: Response;
            try {
                res = await fetch('/api/update-cookies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: text })
                });
            } catch (networkErr) {
                // fetch() itself failed — server is down or unreachable
                throw new Error(
                    'Cannot reach the backend server. A video download may still be in progress — ' +
                    'please wait for it to finish and try again.'
                );
            }

            // Check for HTML response (Vite serving index.html on 404)
            const contentType = res.headers.get('content-type');
            if (contentType && contentType.includes('text/html')) {
                throw new Error('Server endpoint not found. Please restart the backend server.');
            }

            if (!res.ok) {
                const errText = await res.text();
                if (!errText || errText.length === 0) {
                    // Empty 500 body usually means the backend was busy/unreachable
                    throw new Error(
                        'Server returned an empty error (HTTP ' + res.status + '). ' +
                        'This usually means the backend is busy with a download. ' +
                        'Please wait a moment and try again.'
                    );
                }
                // Try to parse JSON error from server
                try {
                    const errJson = JSON.parse(errText);
                    throw new Error(errJson.error || `Server error ${res.status}`);
                } catch (parseErr) {
                    // Not JSON, use raw text
                    if (parseErr instanceof SyntaxError) {
                        throw new Error(`Server error ${res.status}: ${errText.substring(0, 200)}`);
                    }
                    throw parseErr; // Re-throw our custom error
                }
            }

            const data = await res.json();
            if (data.success) {
                alert('YouTube Cookies updated successfully!');
            } else {
                alert('Failed to update cookies: ' + data.error);
            }
        } catch (err: any) {
            console.error('[CookieUpload]', err);
            alert('Error uploading cookies: ' + (err.message || err));
        }

        // Reset input
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    return (
        <>
            <input
                type="file"
                ref={fileInputRef}
                accept=".txt"
                onChange={handleCookieUpload}
                className="hidden"
            />
            <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-1.5 bg-[#222] hover:bg-[#333] border border-[#333] hover:border-gray-600 rounded text-xs text-gray-300 transition-colors"
                title="Upload YouTube cookies.txt to fix download issues"
            >
                <span className="text-lg">🍪</span>
                <span>Update Cookies</span>
            </button>
        </>
    );
};
