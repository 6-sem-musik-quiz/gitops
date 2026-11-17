{{- define "quiz-service.labels" -}}
app.kubernetes.io/name: {{ .Release.Name }}
app.kubernetes.io/part-of: music-quiz
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "quiz-service.selector" -}}
app.kubernetes.io/name: {{ .Release.Name }}
{{- end }}
