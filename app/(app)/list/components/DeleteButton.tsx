"use client";

import { useState } from "react";
import { Icon } from "@/app/components/icons";
import { useIntlayer } from "next-intlayer";

interface DeleteButtonProps {
  url: string;
  title?: string;
}

export default function DeleteButton({ url, title }: DeleteButtonProps) {
  const { deleteCard, deleteCardTitle, deleteFailedAlert, deleteErrorAlert } =
    useIntlayer("list-page");
  // useIntlayer returns IntlayerNode objects: fine as JSX children, but
  // attributes, confirm() and alert() need the plain strings.
  const deleteLabel = deleteCardTitle.value;
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const confirmMessage = title ? `${deleteCard.value} ${title}?` : `${deleteCard.value} ${url}?`;

    if (!confirm(confirmMessage)) {
      return;
    }

    setIsDeleting(true);

    try {
      const response = await fetch(`/api/fsrs/delete?url=${encodeURIComponent(url)}`);

      if (response.ok) {
        window.location.reload();
      } else {
        alert(deleteFailedAlert.value);
        setIsDeleting(false);
      }
    } catch (error) {
      console.error("Delete error:", error);
      alert(deleteErrorAlert.value);
      setIsDeleting(false);
    }
  };

  return (
    <button
      onClick={handleDelete}
      disabled={isDeleting}
      className="ml-2 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
      title={deleteLabel}
      aria-label={deleteLabel}
    >
      {isDeleting ? "..." : <Icon name="trash" label={deleteLabel} className="text-sm" />}
    </button>
  );
}
