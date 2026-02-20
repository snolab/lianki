"use client";

import { useState } from "react";

interface DeleteButtonProps {
  url: string;
  title?: string;
}

export default function DeleteButton({ url, title }: DeleteButtonProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const confirmMessage = title ? `Delete card: ${title}?` : `Delete card: ${url}?`;

    if (!confirm(confirmMessage)) {
      return;
    }

    setIsDeleting(true);

    try {
      const response = await fetch(`/api/fsrs/delete?url=${encodeURIComponent(url)}`);

      if (response.ok) {
        window.location.reload();
      } else {
        alert("Failed to delete card");
        setIsDeleting(false);
      }
    } catch (error) {
      console.error("Delete error:", error);
      alert("Error deleting card");
      setIsDeleting(false);
    }
  };

  return (
    <button
      onClick={handleDelete}
      disabled={isDeleting}
      className="ml-2 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
      title="Delete this card"
    >
      {isDeleting ? "..." : "🗑"}
    </button>
  );
}
