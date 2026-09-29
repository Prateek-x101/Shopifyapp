/** The editor's live preview: the real product page, served from the app so it can be shown in the editor (signed link). */
import type { LoaderFunctionArgs } from "react-router";
import { renderPreview } from "../lib/preview.server";

export const loader = async ({ request }: LoaderFunctionArgs) => renderPreview(request);
