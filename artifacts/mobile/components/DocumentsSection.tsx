/**
 * DocumentsSection — reusable enterprise document manager surface for the mobile
 * app. Drops into any entity detail screen (lead, contact, company, event) to
 * list, upload (camera / gallery / file), preview, download, rename, categorise,
 * version, delete and restore documents for that entity.
 *
 * Contract-first: all data access goes through the generated `@workspace/api-client-react`
 * hooks/functions; native device bridges live in `lib/documents.ts`. The section
 * degrades gracefully — permission denials, oversize files and API errors surface
 * as alerts, and an empty/loading/error state is always shown.
 */

import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  useDeleteDocument,
  useGetDocumentCategories,
  useListDocuments,
  getListDocumentsQueryKey,
  useListDocumentVersions,
  getListDocumentVersionsQueryKey,
  useRestoreDocument,
  useUpdateDocument,
  type Document,
  type DocumentInputEntityType,
  type DocumentVersion,
} from "@workspace/api-client-react";

import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import {
  downloadDocument,
  humanFileSize,
  iconForMime,
  pickDocument,
  previewDocument,
  uploadDocumentVersion,
  uploadNewDocument,
  type DocumentSource,
  type PickedFile,
} from "@/lib/documents";

type EntityType = DocumentInputEntityType;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function DocumentsSection({
  entityType,
  entityId,
}: {
  entityType: EntityType;
  entityId: number;
}) {
  const colors = useColors();
  const { t, textAlign, writingDirection } = useLocale();
  const queryClient = useQueryClient();

  const [category, setCategory] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  // Pending-upload sheet state.
  const [pendingFile, setPendingFile] = useState<PickedFile | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadCategory, setUploadCategory] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Detail sheet state.
  const [detailDoc, setDetailDoc] = useState<Document | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const categoriesQuery = useGetDocumentCategories();
  const catalog = categoriesQuery.data?.[entityType] ?? [];

  const listParams = useMemo(
    () => ({
      entityType,
      entityId,
      ...(category ? { category } : {}),
      includeDeleted: showDeleted,
      limit: 100,
    }),
    [entityType, entityId, category, showDeleted],
  );

  const listQuery = useListDocuments(listParams, {
    query: { enabled: Number.isFinite(entityId) && entityId > 0, queryKey: getListDocumentsQueryKey(listParams) },
  });
  const documents = listQuery.data?.documents ?? [];

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey?.[0] === "string" &&
        (q.queryKey[0] as string).startsWith("/api/documents"),
    });
  }, [queryClient]);

  const updateDoc = useUpdateDocument();
  const deleteDoc = useDeleteDocument();
  const restoreDoc = useRestoreDocument();

  // ── Upload ────────────────────────────────────────────────────────────────
  const startPick = useCallback(
    async (source: DocumentSource) => {
      try {
        const file = await pickDocument(source);
        if (!file) return;
        setPendingFile(file);
        setUploadName(file.name);
        setUploadCategory(catalog[0] ?? "other");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "permission:camera") {
          Alert.alert(t("documents.permissionTitle"), t("documents.permissionCamera"));
        } else if (msg === "permission:gallery") {
          Alert.alert(t("documents.permissionTitle"), t("documents.permissionGallery"));
        } else {
          Alert.alert(t("documents.errorTitle"), t("documents.pickFailed"));
        }
      }
    },
    [catalog, t],
  );

  const openUploadPicker = useCallback(() => {
    const options = [
      { key: "file" as const, label: t("documents.sourceFile") },
      { key: "gallery" as const, label: t("documents.sourceGallery") },
      { key: "camera" as const, label: t("documents.sourceCamera") },
    ];
    if (Platform.OS === "web") {
      // Web: only the file picker is meaningful.
      void startPick("file");
      return;
    }
    Alert.alert(t("documents.uploadTitle"), t("documents.chooseSource"), [
      ...options.map((o) => ({ text: o.label, onPress: () => void startPick(o.key) })),
      { text: t("documents.cancel"), style: "cancel" as const },
    ]);
  }, [startPick, t]);

  const confirmUpload = useCallback(async () => {
    if (!pendingFile || !uploadCategory) return;
    setUploading(true);
    try {
      await uploadNewDocument({
        entityType,
        entityId,
        category: uploadCategory,
        name: uploadName,
        file: pendingFile,
      });
      invalidate();
      setPendingFile(null);
      setUploadName("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      Alert.alert(
        t("documents.errorTitle"),
        msg === "size" ? t("documents.tooLarge") : t("documents.uploadFailed"),
      );
    } finally {
      setUploading(false);
    }
  }, [pendingFile, uploadCategory, uploadName, entityType, entityId, invalidate, t]);

  // ── Row actions ─────────────────────────────────────────────────────────────
  const onPreview = useCallback(
    async (doc: Document) => {
      setBusy(true);
      try {
        await previewDocument(doc.id);
      } catch {
        Alert.alert(t("documents.errorTitle"), t("documents.previewFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const onDownload = useCallback(
    async (doc: Document) => {
      setBusy(true);
      try {
        const { saved } = await downloadDocument(doc.id);
        if (saved === "library") {
          Alert.alert(t("documents.savedTitle"), t("documents.savedToLibrary"));
        }
      } catch {
        Alert.alert(t("documents.errorTitle"), t("documents.downloadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const onDelete = useCallback(
    (doc: Document) => {
      Alert.alert(t("documents.deleteTitle"), t("documents.deleteConfirm"), [
        { text: t("documents.cancel"), style: "cancel" },
        {
          text: t("documents.delete"),
          style: "destructive",
          onPress: () => {
            deleteDoc.mutate(
              { id: doc.id },
              {
                onSuccess: () => {
                  invalidate();
                  setDetailDoc(null);
                },
                onError: () =>
                  Alert.alert(t("documents.errorTitle"), t("documents.deleteFailed")),
              },
            );
          },
        },
      ]);
    },
    [deleteDoc, invalidate, t],
  );

  const onRestore = useCallback(
    (doc: Document) => {
      restoreDoc.mutate(
        { id: doc.id },
        {
          onSuccess: () => {
            invalidate();
            setDetailDoc(null);
          },
          onError: () =>
            Alert.alert(t("documents.errorTitle"), t("documents.restoreFailed")),
        },
      );
    },
    [restoreDoc, invalidate, t],
  );

  const submitRename = useCallback(() => {
    if (!detailDoc) return;
    const name = renameValue.trim();
    if (!name || name === detailDoc.name) {
      setRenaming(false);
      return;
    }
    updateDoc.mutate(
      { id: detailDoc.id, data: { name } },
      {
        onSuccess: (updated) => {
          invalidate();
          setDetailDoc(updated);
          setRenaming(false);
        },
        onError: () => Alert.alert(t("documents.errorTitle"), t("documents.renameFailed")),
      },
    );
  }, [detailDoc, renameValue, updateDoc, invalidate, t]);

  const addVersion = useCallback(
    async (doc: Document) => {
      const run = async (source: DocumentSource) => {
        try {
          const file = await pickDocument(source);
          if (!file) return;
          setBusy(true);
          const updated = await uploadDocumentVersion(doc.id, file);
          invalidate();
          setDetailDoc(updated);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          Alert.alert(
            t("documents.errorTitle"),
            msg === "size" ? t("documents.tooLarge") : t("documents.uploadFailed"),
          );
        } finally {
          setBusy(false);
        }
      };
      if (Platform.OS === "web") {
        void run("file");
        return;
      }
      Alert.alert(t("documents.newVersion"), t("documents.chooseSource"), [
        { text: t("documents.sourceFile"), onPress: () => void run("file") },
        { text: t("documents.sourceGallery"), onPress: () => void run("gallery") },
        { text: t("documents.sourceCamera"), onPress: () => void run("camera") },
        { text: t("documents.cancel"), style: "cancel" },
      ]);
    },
    [invalidate, t],
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  const catLabel = useCallback(
    (key: string) => t(`documents.categories.${key}`, { defaultValue: key }),
    [t],
  );

  return (
    <View style={{ gap: 12 }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontFamily: FONT.semibold, fontSize: 16, color: colors.foreground, textAlign }}>
          {t("documents.title")}
          {documents.length > 0 ? `  (${documents.length})` : ""}
        </Text>
        <Pressable
          onPress={openUploadPicker}
          disabled={busy}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: colors.radius + 2,
            backgroundColor: colors.primary,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Feather name="upload" size={15} color={colors.primaryForeground} />
          <Text style={{ fontFamily: FONT.semibold, fontSize: 13, color: colors.primaryForeground }}>
            {t("documents.upload")}
          </Text>
        </Pressable>
      </View>

      {/* Category filter chips */}
      {catalog.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <FilterChip
            label={t("documents.allCategories")}
            active={category === null}
            onPress={() => setCategory(null)}
          />
          {catalog.map((c) => (
            <FilterChip
              key={c}
              label={catLabel(c)}
              active={category === c}
              onPress={() => setCategory((prev) => (prev === c ? null : c))}
            />
          ))}
          <FilterChip
            label={t("documents.showDeleted")}
            active={showDeleted}
            onPress={() => setShowDeleted((v) => !v)}
            icon="trash-2"
          />
        </ScrollView>
      ) : null}

      {/* List */}
      {listQuery.isLoading ? (
        <View style={{ padding: 24, alignItems: "center" }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : listQuery.isError ? (
        <Pressable
          onPress={() => listQuery.refetch()}
          style={{
            padding: 16,
            borderRadius: colors.radius,
            backgroundColor: colors.destructive + "12",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Feather name="alert-triangle" size={20} color={colors.destructive} />
          <Text style={{ fontFamily: FONT.medium, fontSize: 13, color: colors.destructive }}>
            {t("documents.loadFailed")}
          </Text>
          <Text style={{ fontFamily: FONT.regular, fontSize: 12, color: colors.mutedForeground }}>
            {t("documents.tapRetry")}
          </Text>
        </Pressable>
      ) : documents.length === 0 ? (
        <View
          style={{
            padding: 24,
            borderRadius: colors.radius,
            backgroundColor: colors.muted,
            alignItems: "center",
            gap: 6,
          }}
        >
          <Feather name="folder" size={26} color={colors.mutedForeground} />
          <Text style={{ fontFamily: FONT.medium, fontSize: 14, color: colors.foreground }}>
            {t("documents.empty")}
          </Text>
          <Text
            style={{
              fontFamily: FONT.regular,
              fontSize: 12,
              color: colors.mutedForeground,
              textAlign: "center",
            }}
          >
            {t("documents.emptyDesc")}
          </Text>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {documents.map((doc) => {
            const deleted = !!doc.deletedAt;
            const version = doc.currentVersion;
            return (
              <Pressable
                key={doc.id}
                onPress={() => {
                  setDetailDoc(doc);
                  setRenaming(false);
                  setRenameValue(doc.name);
                }}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  padding: 12,
                  borderRadius: colors.radius,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.card,
                  opacity: pressed ? 0.9 : deleted ? 0.6 : 1,
                })}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: colors.radius,
                    backgroundColor: colors.accent,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Feather
                    name={iconForMime(version?.mimeType) as keyof typeof Feather.glyphMap}
                    size={18}
                    color={colors.primary}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: FONT.medium, fontSize: 14, color: colors.foreground, textAlign }}
                  >
                    {doc.name}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: FONT.regular, fontSize: 12, color: colors.mutedForeground, textAlign }}
                  >
                    {catLabel(doc.category)}
                    {version ? ` · ${humanFileSize(version.fileSize)}` : ""}
                    {` · ${formatDate(doc.updatedAt || doc.createdAt)}`}
                    {(doc.versionCount ?? 1) > 1 ? ` · v${doc.versionCount}` : ""}
                    {deleted ? ` · ${t("documents.deletedTag")}` : ""}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Upload confirm sheet */}
      <Modal
        visible={!!pendingFile}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => (uploading ? null : setPendingFile(null))}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: "#00000066", justifyContent: "flex-end" }}
          onPress={() => (uploading ? null : setPendingFile(null))}
        >
          <Pressable
            style={{
              backgroundColor: colors.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 20,
              gap: 14,
            }}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={{ fontFamily: FONT.semibold, fontSize: 17, color: colors.foreground, textAlign }}>
              {t("documents.uploadTitle")}
            </Text>

            {pendingFile ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  padding: 10,
                  borderRadius: colors.radius,
                  backgroundColor: colors.muted,
                }}
              >
                <Feather
                  name={iconForMime(pendingFile.mimeType) as keyof typeof Feather.glyphMap}
                  size={18}
                  color={colors.primary}
                />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ fontFamily: FONT.medium, fontSize: 13, color: colors.foreground }}>
                    {pendingFile.name}
                  </Text>
                  <Text style={{ fontFamily: FONT.regular, fontSize: 12, color: colors.mutedForeground }}>
                    {humanFileSize(pendingFile.size)}
                  </Text>
                </View>
              </View>
            ) : null}

            <View style={{ gap: 6 }}>
              <Text style={{ fontFamily: FONT.medium, fontSize: 13, color: colors.mutedForeground, textAlign }}>
                {t("documents.name")}
              </Text>
              <TextInput
                value={uploadName}
                onChangeText={setUploadName}
                placeholder={t("documents.namePlaceholder")}
                placeholderTextColor={colors.mutedForeground}
                style={{
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: colors.radius,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: colors.foreground,
                  fontFamily: FONT.regular,
                  fontSize: 14,
                  textAlign,
                  writingDirection,
                }}
              />
            </View>

            {catalog.length > 0 ? (
              <View style={{ gap: 6 }}>
                <Text style={{ fontFamily: FONT.medium, fontSize: 13, color: colors.mutedForeground, textAlign }}>
                  {t("documents.category")}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {catalog.map((c) => (
                    <FilterChip
                      key={c}
                      label={catLabel(c)}
                      active={uploadCategory === c}
                      onPress={() => setUploadCategory(c)}
                    />
                  ))}
                </ScrollView>
              </View>
            ) : null}

            <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
              <Pressable
                onPress={() => (uploading ? null : setPendingFile(null))}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: colors.radius + 2,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: "center",
                }}
              >
                <Text style={{ fontFamily: FONT.semibold, fontSize: 14, color: colors.foreground }}>
                  {t("documents.cancel")}
                </Text>
              </Pressable>
              <Pressable
                onPress={confirmUpload}
                disabled={uploading || !uploadCategory}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  borderRadius: colors.radius + 2,
                  backgroundColor: colors.primary,
                  alignItems: "center",
                  opacity: uploading || !uploadCategory ? 0.6 : 1,
                }}
              >
                {uploading ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={{ fontFamily: FONT.semibold, fontSize: 14, color: colors.primaryForeground }}>
                    {t("documents.upload")}
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Detail sheet */}
      <DocumentDetailSheet
        doc={detailDoc}
        entityType={entityType}
        onClose={() => setDetailDoc(null)}
        busy={busy}
        onPreview={onPreview}
        onDownload={onDownload}
        onDelete={onDelete}
        onRestore={onRestore}
        onAddVersion={addVersion}
        renaming={renaming}
        renameValue={renameValue}
        setRenaming={setRenaming}
        setRenameValue={setRenameValue}
        submitRename={submitRename}
        renamePending={updateDoc.isPending}
      />
    </View>
  );
}

// ── Filter chip ───────────────────────────────────────────────────────────────
function FilterChip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon?: keyof typeof Feather.glyphMap;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? colors.primary : colors.border,
        backgroundColor: active ? colors.primary : colors.card,
      }}
    >
      {icon ? (
        <Feather name={icon} size={12} color={active ? colors.primaryForeground : colors.mutedForeground} />
      ) : null}
      <Text
        style={{
          fontFamily: FONT.medium,
          fontSize: 12,
          color: active ? colors.primaryForeground : colors.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── Detail sheet ──────────────────────────────────────────────────────────────
function DocumentDetailSheet({
  doc,
  onClose,
  busy,
  onPreview,
  onDownload,
  onDelete,
  onRestore,
  onAddVersion,
  renaming,
  renameValue,
  setRenaming,
  setRenameValue,
  submitRename,
  renamePending,
}: {
  doc: Document | null;
  entityType: EntityType;
  onClose: () => void;
  busy: boolean;
  onPreview: (d: Document) => void;
  onDownload: (d: Document) => void;
  onDelete: (d: Document) => void;
  onRestore: (d: Document) => void;
  onAddVersion: (d: Document) => void;
  renaming: boolean;
  renameValue: string;
  setRenaming: (v: boolean) => void;
  setRenameValue: (v: string) => void;
  submitRename: () => void;
  renamePending: boolean;
}) {
  const colors = useColors();
  const { t, textAlign, writingDirection } = useLocale();
  const versionsQuery = useListDocumentVersions(doc?.id ?? 0, {
    query: { enabled: !!doc, queryKey: getListDocumentVersionsQueryKey(doc?.id ?? 0) },
  });
  const versions = versionsQuery.data?.versions ?? [];
  const deleted = !!doc?.deletedAt;

  const downloadVersion = useCallback(
    async (v: DocumentVersion) => {
      if (!doc) return;
      try {
        await downloadDocument(doc.id, { versionId: v.id });
      } catch {
        Alert.alert(t("documents.errorTitle"), t("documents.downloadFailed"));
      }
    },
    [doc, t],
  );

  return (
    <Modal
      visible={!!doc}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable
        style={{ flex: 1, backgroundColor: "#00000066", justifyContent: "flex-end" }}
        onPress={onClose}
      >
        <Pressable
          style={{
            backgroundColor: colors.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 12,
            paddingBottom: 24,
            maxHeight: "85%",
          }}
          onPress={(e) => e.stopPropagation()}
        >
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.border,
              marginBottom: 12,
            }}
          />
          {doc ? (
            <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 0, gap: 16 }}>
              {/* Title */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <View
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: colors.radius,
                    backgroundColor: colors.accent,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Feather
                    name={iconForMime(doc.currentVersion?.mimeType) as keyof typeof Feather.glyphMap}
                    size={22}
                    color={colors.primary}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  {renaming ? (
                    <TextInput
                      value={renameValue}
                      onChangeText={setRenameValue}
                      autoFocus
                      onSubmitEditing={submitRename}
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        borderRadius: colors.radius,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        color: colors.foreground,
                        fontFamily: FONT.medium,
                        fontSize: 15,
                        textAlign,
                        writingDirection,
                      }}
                    />
                  ) : (
                    <Text style={{ fontFamily: FONT.semibold, fontSize: 16, color: colors.foreground, textAlign }}>
                      {doc.name}
                    </Text>
                  )}
                  <Text style={{ fontFamily: FONT.regular, fontSize: 12, color: colors.mutedForeground, textAlign }}>
                    {t(`documents.categories.${doc.category}`, { defaultValue: doc.category })}
                    {doc.currentVersion ? ` · ${humanFileSize(doc.currentVersion.fileSize)}` : ""}
                  </Text>
                </View>
                {renaming ? (
                  <Pressable onPress={submitRename} disabled={renamePending} hitSlop={8}>
                    {renamePending ? (
                      <ActivityIndicator color={colors.primary} size="small" />
                    ) : (
                      <Feather name="check" size={20} color={colors.primary} />
                    )}
                  </Pressable>
                ) : !deleted ? (
                  <Pressable onPress={() => setRenaming(true)} hitSlop={8}>
                    <Feather name="edit-2" size={18} color={colors.mutedForeground} />
                  </Pressable>
                ) : null}
              </View>

              {/* Meta */}
              <View style={{ gap: 4 }}>
                {doc.createdByName ? (
                  <Text style={{ fontFamily: FONT.regular, fontSize: 12, color: colors.mutedForeground, textAlign }}>
                    {t("documents.uploadedBy")}: {doc.createdByName}
                  </Text>
                ) : null}
                <Text style={{ fontFamily: FONT.regular, fontSize: 12, color: colors.mutedForeground, textAlign }}>
                  {t("documents.uploadedOn")}: {formatDate(doc.createdAt)}
                </Text>
              </View>

              {/* Primary actions */}
              <View style={{ flexDirection: "row", gap: 10 }}>
                <ActionButton
                  icon="eye"
                  label={t("documents.preview")}
                  onPress={() => onPreview(doc)}
                  disabled={busy}
                />
                <ActionButton
                  icon="download"
                  label={t("documents.download")}
                  onPress={() => onDownload(doc)}
                  disabled={busy}
                  primary
                />
              </View>

              {!deleted ? (
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <ActionButton
                    icon="file-plus"
                    label={t("documents.newVersion")}
                    onPress={() => onAddVersion(doc)}
                    disabled={busy}
                  />
                  <ActionButton
                    icon="trash-2"
                    label={t("documents.delete")}
                    onPress={() => onDelete(doc)}
                    disabled={busy}
                    destructive
                  />
                </View>
              ) : (
                <ActionButton
                  icon="rotate-ccw"
                  label={t("documents.restore")}
                  onPress={() => onRestore(doc)}
                  disabled={busy}
                  primary
                />
              )}

              {/* Version history */}
              <View style={{ gap: 8 }}>
                <Text style={{ fontFamily: FONT.semibold, fontSize: 14, color: colors.foreground, textAlign }}>
                  {t("documents.versions")}
                </Text>
                {versionsQuery.isLoading ? (
                  <ActivityIndicator color={colors.primary} />
                ) : versions.length === 0 ? (
                  <Text style={{ fontFamily: FONT.regular, fontSize: 12, color: colors.mutedForeground, textAlign }}>
                    {t("documents.noVersions")}
                  </Text>
                ) : (
                  versions.map((v) => {
                    const current = v.id === doc.currentVersionId;
                    return (
                      <View
                        key={v.id}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 10,
                          padding: 10,
                          borderRadius: colors.radius,
                          borderWidth: 1,
                          borderColor: current ? colors.primary : colors.border,
                          backgroundColor: colors.card,
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontFamily: FONT.medium, fontSize: 13, color: colors.foreground, textAlign }}>
                            v{v.versionNumber}
                            {current ? ` · ${t("documents.current")}` : ""}
                            {v.label ? ` · ${v.label}` : ""}
                          </Text>
                          <Text style={{ fontFamily: FONT.regular, fontSize: 11, color: colors.mutedForeground, textAlign }}>
                            {humanFileSize(v.fileSize)} · {formatDate(v.uploadedAt)}
                            {v.uploadedByName ? ` · ${v.uploadedByName}` : ""}
                          </Text>
                        </View>
                        <Pressable onPress={() => downloadVersion(v)} hitSlop={8}>
                          <Feather name="download" size={16} color={colors.primary} />
                        </Pressable>
                      </View>
                    );
                  })
                )}
              </View>
            </ScrollView>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  disabled,
  primary,
  destructive,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  destructive?: boolean;
}) {
  const colors = useColors();
  const fg = primary
    ? colors.primaryForeground
    : destructive
      ? colors.destructive
      : colors.foreground;
  const bg = primary ? colors.primary : colors.card;
  const border = destructive ? colors.destructive : colors.border;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingVertical: 11,
        borderRadius: colors.radius + 2,
        borderWidth: primary ? 0 : 1,
        borderColor: border,
        backgroundColor: bg,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Feather name={icon} size={16} color={fg} />
      <Text style={{ fontFamily: FONT.semibold, fontSize: 13, color: fg }}>{label}</Text>
    </Pressable>
  );
}
