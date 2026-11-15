import type { z } from "zod";
import { commands, contentSchema, emptyContent } from "../shared/contracts.js";
import {
  convertNewsletter,
  hasPrivateNewsletterReference,
  resolveNewsletterPhotos,
} from "../shared/newsletter-import.js";
import { withStudio } from "../shared/studio-legacy.js";
import { digest } from "./content.js";
import { AppError } from "./errors.js";

type ImportRequest = z.infer<
  (typeof commands)["campaign.previewImport"]["schema"]
>;

export function prepareNewsletterImport(
  workspace: string,
  request: ImportRequest,
) {
  try {
    const {
      source,
      format,
      acceptMetadata,
      buttonLinks,
      photoMapping,
      brandId,
      replace,
      title,
      subject,
      preheader,
      fromName,
      replyTo,
    } = request;
    if ([title, subject, preheader, fromName, replyTo].some(hasPrivateNewsletterReference))
      throw Error("Remove private or expiring URLs from the newsletter fields.");
    const conversion = convertNewsletter({
      source,
      format,
      acceptMetadata,
      buttonLinks,
    });
    const document = resolveNewsletterPhotos(conversion.blocks, photoMapping);
    const content = contentSchema.parse(
      withStudio(
        {
          ...emptyContent(),
          title,
          subject,
          preheader,
          fromName,
          replyTo,
        },
        document,
      ),
    );
    // Include the source and review decisions even when two different inputs render alike.
    const fingerprint = digest(
      JSON.stringify([
        workspace,
        brandId,
        replace,
        format,
        source,
        acceptMetadata,
        [...buttonLinks].sort(),
        Object.entries(photoMapping).sort(([a], [b]) => a.localeCompare(b)),
        content,
        conversion.warnings,
      ]),
    );
    return { digest: fingerprint, content, warnings: conversion.warnings };
  } catch (error) {
    throw new AppError(
      422,
      "invalid_newsletter",
      error instanceof Error
        ? error.message
        : "Review the newsletter and its mapped photos.",
    );
  }
}
