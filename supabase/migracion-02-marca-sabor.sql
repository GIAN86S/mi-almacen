-- Migración 2: elegir productos por Marca → Presentación → Sabor.
-- Solo para proyectos creados con la versión anterior de esquema.sql.
-- Pegar en: Supabase → SQL Editor → New query → Run

alter table productos
  add column if not exists marca        text,
  add column if not exists presentacion text,
  add column if not exists sabor        text;
