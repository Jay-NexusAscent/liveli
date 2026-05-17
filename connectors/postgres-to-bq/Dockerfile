FROM meltano/meltano:v3.7.1
WORKDIR /project
COPY meltano.yml ./
# Meltano 3.x doesn't bundle the plugin hub registry — fetch the plugin
# definitions, then install. Without this, every `meltano install` fails
# with "Extractor 'tap-X' is not known to Meltano".
RUN meltano lock --update --all && meltano install
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENTRYPOINT ["./entrypoint.sh"]
