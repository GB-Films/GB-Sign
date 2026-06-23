import React from 'react';

export function Button({ children, variant = 'primary', ...props }) {
  return <button className={`btn ${variant}`} {...props}>{children}</button>;
}

export function Card({ children, className = '' }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Empty({ title, children }) {
  return <div className="empty"><strong>{title}</strong><p>{children}</p></div>;
}

export function Field({ label, children, hint }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Badge({ children, tone = 'neutral' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
