#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UniMCP4CC.Editor
{
  internal static class McpAssetImport
  {
    [Serializable]
    private sealed class ResultPayload
    {
      public string status;
      public string message;
      public string assetPath;
      public string textureType;
      public string gameObjectPath;
      public string componentType;
      public string fieldName;
      public string referenceName;
      public string spriteName;
      public int spriteCount;
      public string[] spriteNames;
      public int candidateCount;
      public string[] candidatePaths;
    }

    private static readonly object TypeCacheLock = new object();
    private static readonly Dictionary<string, Type> TypeCache = new Dictionary<string, Type>(StringComparer.Ordinal);

    public static string SetTextureTypeBase64(string assetPath, string textureType, string reimport)
    {
      string EncodeResult(string status, string message, Action<ResultPayload> configure = null)
      {
        var payload = new ResultPayload
        {
          status = status,
          message = message,
          assetPath = assetPath,
        };

        configure?.Invoke(payload);

        return Encode(payload);
      }

      try
      {
        if (string.IsNullOrWhiteSpace(assetPath))
        {
          return EncodeResult("error", "assetPath is required");
        }

        var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
        if (importer == null)
        {
          return EncodeResult("error", $"No TextureImporter found at path: {assetPath}");
        }

        if (!TryParseTextureImporterType(textureType, out var parsedType))
        {
          return EncodeResult(
            "error",
            $"Unsupported textureType: {textureType}",
            payload => payload.textureType = textureType
          );
        }

        importer.textureType = parsedType;
        if (parsedType == TextureImporterType.Sprite && importer.spriteImportMode == SpriteImportMode.None)
        {
          importer.spriteImportMode = SpriteImportMode.Single;
        }

        if (ParseBoolean(reimport, fallback: true))
        {
          importer.SaveAndReimport();
        }

        return EncodeResult(
          "success",
          "Texture importer updated",
          payload => payload.textureType = importer.textureType.ToString()
        );
      }
      catch (Exception exception)
      {
        return EncodeResult(
          "error",
          exception.Message,
          payload => payload.textureType = textureType
        );
      }
    }

    public static string ListSpritesBase64(string assetPath)
    {
      string EncodeResult(string status, string message, Action<ResultPayload> configure = null)
      {
        var payload = new ResultPayload
        {
          status = status,
          message = message,
          assetPath = assetPath,
        };

        configure?.Invoke(payload);

        return Encode(payload);
      }

      try
      {
        if (string.IsNullOrWhiteSpace(assetPath))
        {
          return EncodeResult("error", "assetPath is required");
        }

        var sprites = CollectSpritesAtPath(assetPath);
        var names = new string[sprites.Count];
        for (var index = 0; index < sprites.Count; index++)
        {
          names[index] = sprites[index] != null ? sprites[index].name : string.Empty;
        }

        return EncodeResult(
          sprites.Count > 0 ? "success" : "error",
          sprites.Count > 0 ? "Sprites found" : $"No sprites found at path: {assetPath}",
          payload =>
          {
            payload.spriteCount = sprites.Count;
            payload.spriteNames = names;
          }
        );
      }
      catch (Exception exception)
      {
        return EncodeResult("error", exception.Message);
      }
    }

    public static string SetSpriteReferenceBase64(
      string gameObjectPath,
      string componentType,
      string fieldName,
      string assetPath,
      string spriteName
    )
    {
      string EncodeResult(string status, string message, Action<ResultPayload> configure = null)
      {
        var payload = new ResultPayload
        {
          status = status,
          message = message,
          gameObjectPath = gameObjectPath,
          componentType = componentType,
          fieldName = fieldName,
          assetPath = assetPath,
        };

        configure?.Invoke(payload);

        return Encode(payload);
      }

      try
      {
        if (string.IsNullOrWhiteSpace(gameObjectPath) || string.IsNullOrWhiteSpace(componentType) || string.IsNullOrWhiteSpace(fieldName))
        {
          return EncodeResult("error", "gameObjectPath, componentType, and fieldName are required");
        }

        var gameObjectMatches = FindSceneGameObjectsByQuery(gameObjectPath);
        if (gameObjectMatches.Count == 0)
        {
          return EncodeResult("error", $"GameObject not found: {gameObjectPath}");
        }

        if (gameObjectMatches.Count > 1)
        {
          var candidatePaths = BuildCandidatePaths(gameObjectMatches, maxCandidates: 10);
          var messageBuilder = new StringBuilder();
          messageBuilder.Append($"GameObject is ambiguous: {gameObjectPath}");
          messageBuilder.Append("\nCandidates:");
          for (var index = 0; index < candidatePaths.Length; index++)
          {
            messageBuilder.Append("\n- ");
            messageBuilder.Append(candidatePaths[index]);
          }
          messageBuilder.Append("\nSpecify a full hierarchy path (e.g. \"Root/Child\").");
          return EncodeResult(
            "error",
            messageBuilder.ToString(),
            payload =>
            {
              payload.candidateCount = gameObjectMatches.Count;
              payload.candidatePaths = candidatePaths;
            }
          );
        }

        var gameObject = gameObjectMatches[0];

        var componentTypeTrimmed = componentType.Trim();
        string[] ambiguousComponentTypes = null;
        Type resolvedComponentType = null;

        if (componentTypeTrimmed.IndexOf('.') < 0)
        {
          resolvedComponentType = ResolveComponentTypeOnGameObject(gameObject, componentTypeTrimmed, out ambiguousComponentTypes);
        }

        if (resolvedComponentType == null && ambiguousComponentTypes == null)
        {
          resolvedComponentType = ResolveType(componentTypeTrimmed, out ambiguousComponentTypes);
        }

        if (resolvedComponentType == null)
        {
          if (ambiguousComponentTypes != null && ambiguousComponentTypes.Length > 0)
          {
            var messageBuilder = new StringBuilder();
            messageBuilder.Append($"Component type is ambiguous: {componentTypeTrimmed}");
            messageBuilder.Append("\nCandidates:");
            for (var index = 0; index < ambiguousComponentTypes.Length; index++)
            {
              messageBuilder.Append("\n- ");
              messageBuilder.Append(ambiguousComponentTypes[index]);
            }
            messageBuilder.Append("\nSpecify a fully qualified type name (Namespace.TypeName).");
            return EncodeResult("error", messageBuilder.ToString());
          }

          return EncodeResult("error", $"Component type not found: {componentTypeTrimmed}");
        }

        var component = gameObject.GetComponent(resolvedComponentType);
        if (component == null)
        {
          return EncodeResult("error", $"Component not found: {componentType} on {gameObjectPath}");
        }

        if (string.IsNullOrWhiteSpace(assetPath))
        {
          return EncodeResult("error", "assetPath is required");
        }

        var sprites = CollectSpritesAtPath(assetPath);
        if (sprites.Count == 0)
        {
          return EncodeResult("error", $"Sprite not found at path: {assetPath}");
        }

        Sprite sprite = null;
        var spriteNameTrimmed = string.IsNullOrWhiteSpace(spriteName) ? string.Empty : spriteName.Trim();
        if (!string.IsNullOrEmpty(spriteNameTrimmed))
        {
          foreach (var candidate in sprites)
          {
            if (candidate != null && string.Equals(candidate.name, spriteNameTrimmed, StringComparison.Ordinal))
            {
              sprite = candidate;
              break;
            }
          }

          if (sprite == null)
          {
            foreach (var candidate in sprites)
            {
              if (candidate != null && string.Equals(candidate.name, spriteNameTrimmed, StringComparison.OrdinalIgnoreCase))
              {
                sprite = candidate;
                break;
              }
            }
          }
        }
        else if (sprites.Count == 1)
        {
          sprite = sprites[0];
        }

        if (sprite == null)
        {
          var names = new string[sprites.Count];
          for (var index = 0; index < sprites.Count; index++)
          {
            names[index] = sprites[index] != null ? sprites[index].name : string.Empty;
          }

          return EncodeResult(
            "error",
            sprites.Count <= 1
              ? $"Sprite not found at path: {assetPath}"
              : $"Multiple sprites found at path: {assetPath}. Specify spriteName.",
            payload =>
            {
              payload.spriteName = spriteNameTrimmed;
              payload.spriteCount = sprites.Count;
              payload.spriteNames = names;
            }
          );
        }

        if (component is SpriteRenderer spriteRenderer && string.Equals(fieldName.Trim(), "sprite", StringComparison.OrdinalIgnoreCase))
        {
          spriteRenderer.sprite = sprite;
          EditorUtility.SetDirty(spriteRenderer);
          return EncodeResult(
            "success",
            "SpriteRenderer.sprite updated",
            payload =>
            {
              payload.referenceName = sprite.name;
              payload.spriteName = sprite.name;
            }
          );
        }

        var serializedObject = new SerializedObject(component);
        var property = serializedObject.FindProperty(fieldName);
        if (property == null)
        {
          return EncodeResult("error", $"SerializedProperty not found: {fieldName}");
        }

        if (property.propertyType != SerializedPropertyType.ObjectReference)
        {
          return EncodeResult("error", $"Property is not an ObjectReference: {fieldName} ({property.propertyType})");
        }

        property.objectReferenceValue = sprite;
        serializedObject.ApplyModifiedPropertiesWithoutUndo();
        EditorUtility.SetDirty(component);

        return EncodeResult(
          "success",
          "Sprite reference updated",
          payload =>
          {
            payload.referenceName = sprite.name;
            payload.spriteName = sprite.name;
          }
        );
      }
      catch (Exception exception)
      {
        return EncodeResult(
          "error",
          exception.Message,
          payload => payload.spriteName = spriteName
        );
      }
    }

    private static List<Sprite> CollectSpritesAtPath(string assetPath)
    {
      var sprites = new List<Sprite>();
      if (string.IsNullOrWhiteSpace(assetPath))
      {
        return sprites;
      }

      var seen = new HashSet<int>();

      void AddSprite(Sprite sprite)
      {
        if (sprite == null)
        {
          return;
        }

        var id = sprite.GetInstanceID();
        if (!seen.Add(id))
        {
          return;
        }

        sprites.Add(sprite);
      }

      AddSprite(AssetDatabase.LoadAssetAtPath<Sprite>(assetPath));

      foreach (var asset in AssetDatabase.LoadAllAssetsAtPath(assetPath))
      {
        if (asset is Sprite sprite)
        {
          AddSprite(sprite);
        }
      }

      foreach (var asset in AssetDatabase.LoadAllAssetRepresentationsAtPath(assetPath))
      {
        if (asset is Sprite sprite)
        {
          AddSprite(sprite);
        }
      }

      sprites.Sort((left, right) => string.CompareOrdinal(left ? left.name : string.Empty, right ? right.name : string.Empty));

      return sprites;
    }

    private static List<GameObject> FindSceneGameObjectsByQuery(string query)
    {
      var matches = new List<GameObject>();
      if (string.IsNullOrWhiteSpace(query))
      {
        return matches;
      }

      var trimmed = query.Trim();
      if (trimmed.IndexOf('/') >= 0)
      {
        FindSceneGameObjectsByPath(trimmed, matches);
      }
      else
      {
        FindSceneGameObjectsByName(trimmed, matches);
      }

      return matches;
    }

    private static IEnumerable<Scene> EnumerateLoadedScenes()
    {
      var prefabStage = PrefabStageUtility.GetCurrentPrefabStage();
      var prefabStageScene = prefabStage != null ? prefabStage.scene : default;
      var hasPrefabStageScene = prefabStage != null;

      var sceneCount = SceneManager.sceneCount;
      for (var index = 0; index < sceneCount; index++)
      {
        var scene = SceneManager.GetSceneAt(index);
        if (!scene.IsValid() || !scene.isLoaded)
        {
          continue;
        }

        if (hasPrefabStageScene && scene == prefabStageScene)
        {
          continue;
        }

        yield return scene;
      }
    }

    private static void FindSceneGameObjectsByPath(string path, List<GameObject> matches)
    {
      if (matches == null)
      {
        return;
      }

      var segments = path.Split('/');
      if (segments.Length == 0)
      {
        return;
      }

      var seen = new HashSet<int>();

      foreach (var scene in EnumerateLoadedScenes())
      {
        var roots = scene.GetRootGameObjects();
        var current = new List<GameObject>();
        for (var rootIndex = 0; rootIndex < roots.Length; rootIndex++)
        {
          var root = roots[rootIndex];
          if (root != null && string.Equals(root.name, segments[0], StringComparison.Ordinal))
          {
            current.Add(root);
          }
        }

        for (var segmentIndex = 1; segmentIndex < segments.Length && current.Count > 0; segmentIndex++)
        {
          var next = new List<GameObject>();
          var segment = segments[segmentIndex];
          for (var currentIndex = 0; currentIndex < current.Count; currentIndex++)
          {
            var candidate = current[currentIndex];
            if (candidate == null)
            {
              continue;
            }
            var transform = candidate.transform;
            if (transform == null)
            {
              continue;
            }
            for (var childIndex = 0; childIndex < transform.childCount; childIndex++)
            {
              var child = transform.GetChild(childIndex);
              if (child != null && string.Equals(child.name, segment, StringComparison.Ordinal))
              {
                next.Add(child.gameObject);
              }
            }
          }
          current = next;
        }

        for (var currentIndex = 0; currentIndex < current.Count; currentIndex++)
        {
          var candidate = current[currentIndex];
          if (candidate == null)
          {
            continue;
          }
          if (seen.Add(candidate.GetInstanceID()))
          {
            matches.Add(candidate);
          }
        }
      }
    }

    private static void FindSceneGameObjectsByName(string name, List<GameObject> matches)
    {
      if (matches == null)
      {
        return;
      }

      var seen = new HashSet<int>();
      foreach (var scene in EnumerateLoadedScenes())
      {
        var roots = scene.GetRootGameObjects();
        for (var rootIndex = 0; rootIndex < roots.Length; rootIndex++)
        {
          var root = roots[rootIndex];
          if (root == null)
          {
            continue;
          }
          foreach (var transform in root.GetComponentsInChildren<Transform>(true))
          {
            if (transform == null)
            {
              continue;
            }
            if (!string.Equals(transform.name, name, StringComparison.Ordinal))
            {
              continue;
            }
            var candidate = transform.gameObject;
            if (candidate == null)
            {
              continue;
            }
            if (seen.Add(candidate.GetInstanceID()))
            {
              matches.Add(candidate);
            }
          }
        }
      }
    }

    private static string[] BuildCandidatePaths(List<GameObject> matches, int maxCandidates)
    {
      if (matches == null || matches.Count == 0 || maxCandidates <= 0)
      {
        return Array.Empty<string>();
      }

      var paths = new List<string>(matches.Count);
      var seen = new HashSet<string>(StringComparer.Ordinal);
      for (var index = 0; index < matches.Count; index++)
      {
        var candidate = matches[index];
        if (candidate == null)
        {
          continue;
        }
        var path = GetHierarchyPath(candidate);
        if (string.IsNullOrWhiteSpace(path))
        {
          continue;
        }
        if (seen.Add(path))
        {
          paths.Add(path);
        }
      }

      paths.Sort(StringComparer.Ordinal);
      var count = paths.Count > maxCandidates ? maxCandidates : paths.Count;
      var result = new string[count];
      for (var index = 0; index < count; index++)
      {
        result[index] = paths[index];
      }

      return result;
    }

    private static string GetHierarchyPath(GameObject gameObject)
    {
      if (gameObject == null)
      {
        return string.Empty;
      }

      var transform = gameObject.transform;
      if (transform == null)
      {
        return gameObject.name ?? string.Empty;
      }

      var names = new Stack<string>();
      var current = transform;
      while (current != null)
      {
        names.Push(current.name);
        current = current.parent;
      }

      return string.Join("/", names.ToArray());
    }

    private static bool TryParseTextureImporterType(string value, out TextureImporterType parsed)
    {
      if (string.IsNullOrWhiteSpace(value))
      {
        parsed = TextureImporterType.Default;
        return true;
      }

      switch (value.Trim().ToLowerInvariant())
      {
        case "default":
          parsed = TextureImporterType.Default;
          return true;
        case "sprite":
          parsed = TextureImporterType.Sprite;
          return true;
        case "normalmap":
        case "normal_map":
          parsed = TextureImporterType.NormalMap;
          return true;
        case "gui":
        case "ui":
          parsed = TextureImporterType.GUI;
          return true;
        case "cursor":
          parsed = TextureImporterType.Cursor;
          return true;
        case "cookie":
          parsed = TextureImporterType.Cookie;
          return true;
        case "lightmap":
          parsed = TextureImporterType.Lightmap;
          return true;
        case "singlechannel":
        case "singechannel":
        case "single_channel":
          parsed = TextureImporterType.SingleChannel;
          return true;
        default:
          parsed = TextureImporterType.Default;
          return false;
      }
    }

    private static Type ResolveComponentTypeOnGameObject(GameObject gameObject, string typeName, out string[] ambiguousCandidates)
    {
      ambiguousCandidates = null;
      if (gameObject == null || string.IsNullOrWhiteSpace(typeName))
      {
        return null;
      }

      var trimmed = typeName.Trim();
      if (trimmed.Length == 0)
      {
        return null;
      }

      var matches = new HashSet<Type>();
      foreach (var component in gameObject.GetComponents<Component>())
      {
        if (component == null)
        {
          continue;
        }

        var candidate = component.GetType();
        if (candidate != null && string.Equals(candidate.Name, trimmed, StringComparison.Ordinal))
        {
          matches.Add(candidate);
        }
      }

      if (matches.Count == 1)
      {
        foreach (var candidate in matches)
        {
          return candidate;
        }
      }

      if (matches.Count > 1)
      {
        var names = new List<string>(matches.Count);
        foreach (var candidate in matches)
        {
          var fullName = candidate.FullName;
          names.Add(string.IsNullOrEmpty(fullName) ? candidate.Name : fullName);
        }

        names.Sort(StringComparer.Ordinal);

        var max = names.Count > 10 ? 10 : names.Count;
        ambiguousCandidates = new string[max];
        for (var index = 0; index < max; index++)
        {
          ambiguousCandidates[index] = names[index];
        }
      }

      return null;
    }

    private static Type ResolveType(string typeName, out string[] ambiguousCandidates)
    {
      ambiguousCandidates = null;
      if (string.IsNullOrWhiteSpace(typeName))
      {
        return null;
      }

      var trimmed = typeName.Trim();
      lock (TypeCacheLock)
      {
        if (TypeCache.TryGetValue(trimmed, out var cached) && cached != null)
        {
          return cached;
        }
      }

      var resolved = ResolveTypeUncached(trimmed, out ambiguousCandidates);
      if (resolved != null)
      {
        lock (TypeCacheLock)
        {
          TypeCache[trimmed] = resolved;
        }
      }

      return resolved;
    }

    private static Type ResolveTypeUncached(string trimmed, out string[] ambiguousCandidates)
    {
      ambiguousCandidates = null;
      var found = Type.GetType(trimmed);
      if (found != null && typeof(Component).IsAssignableFrom(found))
      {
        return found;
      }

      foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
      {
        try
        {
          var candidate = assembly.GetType(trimmed);
          if (candidate != null && typeof(Component).IsAssignableFrom(candidate))
          {
            return candidate;
          }
        }
        catch
        {
          // ignore and continue
        }
      }

      if (trimmed.IndexOf('.') >= 0)
      {
        return null;
      }

      var matches = new List<Type>();
      foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
      {
        try
        {
          foreach (var candidate in assembly.GetTypes())
          {
            if (
              candidate != null &&
              typeof(Component).IsAssignableFrom(candidate) &&
              string.Equals(candidate.Name, trimmed, StringComparison.Ordinal)
            )
            {
              matches.Add(candidate);
              if (matches.Count >= 32)
              {
                break;
              }
            }
          }
        }
        catch
        {
          // ignore and continue
        }

        if (matches.Count >= 32)
        {
          break;
        }
      }

      if (matches.Count == 1)
      {
        return matches[0];
      }

      if (matches.Count > 1)
      {
        var names = new List<string>(matches.Count);
        for (var index = 0; index < matches.Count; index++)
        {
          var fullName = matches[index].FullName;
          names.Add(string.IsNullOrEmpty(fullName) ? matches[index].Name : fullName);
        }

        names.Sort(StringComparer.Ordinal);

        var max = names.Count > 10 ? 10 : names.Count;
        ambiguousCandidates = new string[max];
        for (var index = 0; index < max; index++)
        {
          ambiguousCandidates[index] = names[index];
        }
      }

      return null;
    }

    private static bool ParseBoolean(string value, bool fallback)
    {
      if (string.IsNullOrWhiteSpace(value))
      {
        return fallback;
      }

      switch (value.Trim().ToLowerInvariant())
      {
        case "1":
        case "true":
        case "yes":
        case "y":
        case "on":
          return true;
        case "0":
        case "false":
        case "no":
        case "n":
        case "off":
          return false;
        default:
          return fallback;
      }
    }

    private static string Encode(ResultPayload payload)
    {
      var json = JsonUtility.ToJson(payload);
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }
  }
}
#endif
