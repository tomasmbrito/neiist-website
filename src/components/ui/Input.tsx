import React, { forwardRef } from "react";
import styles from "@/styles/components/ui/Input.module.css";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", ...props }, ref) => {
    return <input ref={ref} className={`${styles.input} ${className}`.trim()} {...props} />;
  }
);
Input.displayName = "Input";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", ...props }, ref) => {
    return <textarea ref={ref} className={`${styles.textarea} ${className}`.trim()} {...props} />;
  }
);
Textarea.displayName = "Textarea";
