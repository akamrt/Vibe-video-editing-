import React, { useRef } from 'react';

export const CookieUploadButton: React.FC = () => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleCookieUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const res = await fetch('/api/update-cookies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text })
            });

            // Check for HTML response (Vite serving index.html on 404)
            const contentType = res.headers.get('content-type');
            if (contentType && contentType.includes('text/html')) {
                throw new Error('Server endpoint not found. Please restart the backend server.');
            }

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Server returned ${res.status}: ${errText}`);
            }

            const data = await res.json();
            if (data.success) {
                alert('🍪 YouTube Cookies updated successfully!');
            } else {
                alert('Failed to update cookies: ' + data.error);
            }
        } catch (err: any) {
            console.error(err);
            if (err.name === 'SyntaxError' || (err.message && err.message.includes('JSON'))) {
                alert('Error: Server returned invalid format. The backend has been restarted, please try again in a moment.');
            } else {
                alert('Error uploading cookies: ' + (err.message || err));
            }
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
