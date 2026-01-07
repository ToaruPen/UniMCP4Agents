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
  internal static class McpComponentTools
  {
    [Serializable]
    private sealed class ResultPayload
    {
      public string status;
      public string message;
      public string gameObjectPath;
      public string componentType;
      public string resolvedComponentType;
      public string addedComponentType;
      public int candidateCount;
      public string[] candidatePaths;
      public string[] ambiguousComponentTypes;
    }

    private static readonly object TypeCacheLock = new object();
    private static readonly Dictionary<string, Type> TypeCache = new Dictionary<string, Type>(StringComparer.Ordinal);

    public static string AddComponentBase64(string gameObjectPath, string componentType)
    {
      return AddComponentBase64(gameObjectPath, componentType, false);
    }

    public static string AddComponentBase64V2(string gameObjectPath, string componentType, bool removeConflictingRenderers)
    {
      return AddComponentBase64(gameObjectPath, componentType, removeConflictingRenderers);
    }

    public static string AddComponentBase64(string gameObjectPath, string componentType, bool removeConflictingRenderers)
    {
      string EncodeResult(string status, string message, Action<ResultPayload> configure = null)
      {
        var payload = new ResultPayload
        {
          status = status,
          message = message,
          gameObjectPath = gameObjectPath,
          componentType = componentType,
        };

        configure?.Invoke(payload);

        return Encode(payload);
      }

      try
      {
        if (string.IsNullOrWhiteSpace(gameObjectPath) || string.IsNullOrWhiteSpace(componentType))
        {
          return EncodeResult("error", "gameObjectPath and componentType are required");
        }

        var matches = FindSceneGameObjectsByQuery(gameObjectPath);
        if (matches.Count == 0)
        {
          return EncodeResult("error", $"GameObject not found: {gameObjectPath}");
        }

        if (matches.Count > 1)
        {
          var candidatePaths = BuildCandidatePaths(matches, maxCandidates: 10);
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
              payload.candidateCount = matches.Count;
              payload.candidatePaths = candidatePaths;
            }
          );
        }

        var gameObject = matches[0];
        if (gameObject == null)
        {
          return EncodeResult("error", $"GameObject not found: {gameObjectPath}");
        }

        var componentTypeTrimmed = componentType.Trim();
        string[] ambiguousComponentTypes = null;
        var resolvedType = ResolveType(componentTypeTrimmed, out ambiguousComponentTypes);

        if (resolvedType == null)
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

            return EncodeResult(
              "error",
              messageBuilder.ToString(),
              payload => payload.ambiguousComponentTypes = ambiguousComponentTypes
            );
          }

          return EncodeResult("error", $"Component type not found: {componentTypeTrimmed}");
        }

        if (Attribute.IsDefined(resolvedType, typeof(DisallowMultipleComponent)) && gameObject.GetComponent(resolvedType) != null)
        {
          return EncodeResult("error", $"Component already exists: {resolvedType.FullName ?? resolvedType.Name}");
        }

        if (resolvedType == typeof(SpriteRenderer))
        {
          var hasMeshFilter = gameObject.GetComponent<MeshFilter>() != null;
          var hasMeshRenderer = gameObject.GetComponent<MeshRenderer>() != null;
          if (hasMeshFilter || hasMeshRenderer)
          {
            if (!removeConflictingRenderers)
            {
              return EncodeResult(
                "error",
                "SpriteRenderer conflicts with existing MeshFilter/MeshRenderer on this GameObject. " +
                "Remove those components, create an empty GameObject, or re-run with removeConflictingRenderers: true."
              );
            }

            try
            {
              var meshRenderer = gameObject.GetComponent<MeshRenderer>();
              if (meshRenderer != null)
              {
                Undo.DestroyObjectImmediate(meshRenderer);
              }

              var meshFilter = gameObject.GetComponent<MeshFilter>();
              if (meshFilter != null)
              {
                Undo.DestroyObjectImmediate(meshFilter);
              }

              if (gameObject.GetComponent<MeshFilter>() != null || gameObject.GetComponent<MeshRenderer>() != null)
              {
                return EncodeResult("error", "Failed to remove conflicting MeshFilter/MeshRenderer components.");
              }

              EditorUtility.SetDirty(gameObject);
            }
            catch (Exception exception)
            {
              return EncodeResult("error", $"Failed to remove conflicting MeshFilter/MeshRenderer components: {exception.Message}");
            }
          }
        }

        Component addedComponent;
        try
        {
          addedComponent = Undo.AddComponent(gameObject, resolvedType);
        }
        catch (Exception exception)
        {
          var hint = BuildAddComponentFailureHint(gameObject, resolvedType);
          var message = $"Failed to add component: {exception.Message}";
          if (!string.IsNullOrWhiteSpace(hint))
          {
            message = $"{message}\n{hint}";
          }
          return EncodeResult("error", message);
        }

        if (addedComponent == null)
        {
          var hint = BuildAddComponentFailureHint(gameObject, resolvedType);
          var message = $"Failed to add component: {resolvedType.FullName ?? resolvedType.Name}";
          if (!string.IsNullOrWhiteSpace(hint))
          {
            message = $"{message}\n{hint}";
          }
          return EncodeResult(
            "error",
            message,
            payload => payload.resolvedComponentType = resolvedType.FullName ?? resolvedType.Name
          );
        }

        EditorUtility.SetDirty(gameObject);
        EditorUtility.SetDirty(addedComponent);

        return EncodeResult(
          "success",
          "Component added",
          payload =>
          {
            payload.resolvedComponentType = resolvedType.FullName ?? resolvedType.Name;
            payload.addedComponentType = addedComponent.GetType().FullName ?? addedComponent.GetType().Name;
            payload.gameObjectPath = GetHierarchyPath(gameObject);
          }
        );
      }
      catch (Exception exception)
      {
        return EncodeResult("error", exception.Message);
      }
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

    private static string BuildAddComponentFailureHint(GameObject gameObject, Type resolvedType)
    {
      if (gameObject == null || resolvedType == null)
      {
        return null;
      }

      if (resolvedType == typeof(SpriteRenderer))
      {
        var hasMeshFilter = gameObject.GetComponent<MeshFilter>() != null;
        var hasMeshRenderer = gameObject.GetComponent<MeshRenderer>() != null;
        if (hasMeshFilter || hasMeshRenderer)
        {
          return
            "SpriteRenderer conflicts with existing MeshFilter/MeshRenderer on this GameObject. " +
            "Remove those components, create an empty GameObject, or re-run with removeConflictingRenderers: true.";
        }
      }

      if (resolvedType.FullName == "UnityEngine.Tilemaps.TilemapRenderer")
      {
        var hasMeshFilter = gameObject.GetComponent<MeshFilter>() != null;
        var hasMeshRenderer = gameObject.GetComponent<MeshRenderer>() != null;
        if (hasMeshFilter || hasMeshRenderer)
        {
          return
            "TilemapRenderer conflicts with existing MeshFilter/MeshRenderer on this GameObject. " +
            "Use GameObject/2D Object/Tilemap/Rectangular, or create an empty GameObject and add Tilemap + TilemapRenderer.";
        }
      }

      return null;
    }

    private static string Encode(ResultPayload payload)
    {
      var json = JsonUtility.ToJson(payload);
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }
  }
}
#endif
